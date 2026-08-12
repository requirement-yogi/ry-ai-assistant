import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerListTraceabilityMatricesTool } from "../../../src/features/list_traceability_matrices/tool.js"
import { TOOL_NAMES } from "../../../src/prompts/index.generated.js"
import { resetRyClient } from "../../../src/core/api/ryClient.js"

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
  registerListTraceabilityMatricesTool(server)

  client = new Client({ name: "test-client", version: "0.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const listed = (await client.listTools()).tools as ListedTool[]
  tool = listed.find((t) => t.name === TOOL_NAMES.listTraceabilityMatrices)!
})

describe("list_traceability_matrices", () => {
  it("is registered with a description from its prompt file", () => {
    expect(tool).toBeDefined()
    expect(tool.description).toBeTruthy()
  })

  it("declares a structured result and is read-only", () => {
    expect(tool.outputSchema).toBeDefined()
    expect(tool.annotations?.readOnlyHint).toBe(true)
  })
})

function stubFetch(reply: { body: unknown }) {
  const calls: { url: string; body?: unknown }[] = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (url.includes("/telemetry")) return { ok: true, status: 204, statusText: "OK", text: async () => "" } as Response
    calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined })
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(reply.body) } as Response
  })
  return calls
}

const callTool = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<{
    isError?: boolean
    content: { text: string }[]
    structuredContent?: Record<string, any>
  }>

describe("calling list_traceability_matrices end to end", () => {
  beforeAll(() => {
    process.env.RY_DATA_RESIDENCY = "EU"
    process.env.RY_PERSONAL_ACCESS_TOKEN = "tok"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetRyClient()
  })

  it("lists saved matrices with the filters the backend requires", async () => {
    const calls = stubFetch({ body: { results: [{ id: 1, name: "A", spaceKey: "DEMO" }], total: 1 } })
    const result = await callTool(TOOL_NAMES.listTraceabilityMatrices, {
      space: "DEMO",
      base_url: "https://acme.atlassian.net",
    })

    expect(result.structuredContent).toMatchObject({ total: 1, returned: 1, offset: 0 })
    // `owned` is required by RYEntityFilters, and the default keeps the list to traceability matrices.
    expect(calls[0].body).toEqual({ owned: true, spaceKey: "DEMO", matrixType: "TRACEABILITY" })
  })
})
