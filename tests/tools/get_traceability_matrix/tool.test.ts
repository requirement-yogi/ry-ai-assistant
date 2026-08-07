import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerGetTraceabilityMatrixTool } from "../../../src/tools/get_traceability_matrix/tool.js"
import { TOOL_NAMES } from "../../../src/core/mcp/toolNames.js"
import { resetRyClient } from "../../../src/core/ryClient.js"

type ListedTool = {
  name: string
  description?: string
  outputSchema?: { properties?: Record<string, unknown> }
  annotations?: Record<string, unknown>
}

let tool: ListedTool
let client: Client

beforeAll(async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerGetTraceabilityMatrixTool(server)

  client = new Client({ name: "test-client", version: "0.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const listed = (await client.listTools()).tools as ListedTool[]
  tool = listed.find((t) => t.name === TOOL_NAMES.getTraceabilityMatrix)!
})

describe("get_traceability_matrix", () => {
  it("is registered with a description from its prompt file", () => {
    expect(tool).toBeDefined()
    expect(tool.description).toBeTruthy()
  })

  it("declares a structured result and is read-only", () => {
    expect(tool.outputSchema).toBeDefined()
    expect(tool.annotations?.readOnlyHint).toBe(true)
  })
})

type Reply = { status?: number; body?: unknown }

function stubFetch(replies: Reply[]) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (url.includes("/telemetry")) return { ok: true, status: 204, statusText: "OK", text: async () => "" } as Response
    const reply = replies.shift() ?? { body: {} }
    const status = reply.status ?? 200
    const text = reply.body !== undefined ? JSON.stringify(reply.body) : ""
    return { ok: status < 300, status, statusText: "OK", text: async () => text } as Response
  })
}

const callTool = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<{
    isError?: boolean
    content: { text: string }[]
    structuredContent?: Record<string, any>
  }>

describe("calling get_traceability_matrix end to end", () => {
  beforeAll(() => {
    process.env.RY_DATA_RESIDENCY = "EU"
    process.env.RY_PERSONAL_ACCESS_TOKEN = "tok"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetRyClient()
  })

  const base_url = "https://acme.atlassian.net"

  it("reads a saved matrix back, parsing the definition out of its json string", async () => {
    const definition = { columns: [{ columnIndex: 0, step: { type: "FIRST_COLUMN", value: null } }], query: "q", spaceKey: "DEMO" }
    stubFetch([{ body: { id: 5, name: "M", spaceKey: "DEMO", query: "q", json: JSON.stringify(definition) } }])

    const result = await callTool(TOOL_NAMES.getTraceabilityMatrix, { matrix_id: 5, base_url })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ id: 5, name: "M", warnings: [] })
    expect(result.structuredContent?.definition).toMatchObject({ query: "q" })
  })

  it("surfaces an unreadable saved matrix as a failure with guidance", async () => {
    stubFetch([{ body: { id: 6, json: "{not json" } }])
    const result = await callTool(TOOL_NAMES.getTraceabilityMatrix, { matrix_id: 6, base_url })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("not valid JSON")
    // The guidance comes from the error class, wired in by registry.ts.
    expect(result.content[0].text).toContain("check_for_updates")
  })
})
