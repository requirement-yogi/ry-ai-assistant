import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerDiscoverMatrixColumnsTool } from "../../../src/features/discover_matrix_columns/tool.js"
import { TOOL_NAMES } from "../../../src/prompts/index.generated.js"
import { resetRyClient } from "../../../src/core/api/ryClient.js"

// discover_matrix_columns as a CLIENT sees it, over a real (in-memory) MCP connection.
//
// First what is declared: listing the tool is what converts its inputSchema to JSON Schema, so a
// shape the conversion cannot express fails here rather than in front of a user. Then (second
// describe) what it DOES, with only `fetch` stubbed — nothing here reaches a network.

type ListedTool = {
  name: string
  description?: string
  inputSchema: { properties?: Record<string, any>; required?: string[] }
  outputSchema?: { properties?: Record<string, unknown> }
}

let tool: ListedTool
let client: Client

beforeAll(async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerDiscoverMatrixColumnsTool(server)

  client = new Client({ name: "test-client", version: "0.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const listed = (await client.listTools()).tools as ListedTool[]
  tool = listed.find((t) => t.name === TOOL_NAMES.discoverMatrixColumns)!
})

describe("discover_matrix_columns", () => {
  it("is registered with a description from its prompt file", () => {
    expect(tool).toBeDefined()
    expect(tool.description).toBeTruthy()
  })

  it("tells the model the traps in the description it will actually read", () => {
    // The description is the only place the model learns that the vocabulary is data-dependent and
    // that a false all* flag means "already used". Losing that turns this tool into a convenient
    // way to save matrices that render nothing.
    expect(tool.description).toContain("NEVER invent")
    expect(tool.description).toMatch(/already used/i)
    expect(tool.description).toMatch(/one round trip per level|call again/i)
  })

  it("is callable with no columns at all — that is step one of the loop", () => {
    expect(tool.inputSchema.required).toEqual(["space", "query"])
  })

  it("declares no structured result", () => {
    // Its payload is a whole space's vocabulary, and the spec would have us serialise it into a
    // text block too — sending it twice for no gain. Same call as search_requirements.
    expect(tool.outputSchema).toBeUndefined()
  })
})

// Calling the handler for real, over the same connection, with only `fetch` stubbed. This is what
// catches the wiring the unit tests can't see: that the request the client ends up making is the
// one the API expects. `base_url` is passed so the client never needs to resolve the Confluence
// instance, which keeps each call to exactly the round trips under test.

type Reply = { status?: number; body?: unknown }

function stubFetch(replies: Reply[]) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  let call = 0
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    // Every tool fires a best-effort telemetry ping through the same fetch. It is fire-and-forget
    // and swallows its own failures, so it is neither recorded nor allowed to consume a reply —
    // otherwise it would shift every response by one.
    if (url.includes("/telemetry")) return { ok: true, status: 204, statusText: "OK", text: async () => "" } as Response
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    })
    const reply = replies[call++] ?? { body: {} }
    const status = reply.status ?? 200
    const text = reply.body !== undefined ? JSON.stringify(reply.body) : ""
    return { ok: status < 300, status, statusText: "OK", text: async () => text } as Response
  })
  return calls
}

const callTool = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<{
    isError?: boolean
    content: { text: string }[]
    structuredContent?: Record<string, any>
  }>

describe("calling discover_matrix_columns end to end", () => {
  beforeAll(() => {
    process.env.RY_DATA_RESIDENCY = "EU"
    process.env.RY_PERSONAL_ACCESS_TOKEN = "tok"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    // The shared client caches its config, so drop it with the stub it was built against.
    resetRyClient()
  })

  const suggestions = (...entries: unknown[]) => ({ body: { columnSuggestions: entries } })
  const base = { space: "DEMO", query: "key ~ 'FN-%'", base_url: "https://acme.atlassian.net" }

  it("discovers the columns of a bare matrix", async () => {
    const calls = stubFetch([suggestions({ propertySuggestions: [{ property: "Priority" }] })])
    const result = await callTool(TOOL_NAMES.discoverMatrixColumns, base)

    expect(result.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://confluence.requirementyogi.com/rest/traceability/DEMO")
    expect(result.content[0].text).toContain('"type":"PROPERTY","value":"Priority"')
  })

  it("probes WITH the columns already picked, so the loop can go a level deeper", async () => {
    // The whole premise of the feature is one round trip per level of depth. If the handler drops the
    // `columns` it was given, every response describes column 0 again and the caller can never see
    // what hangs UNDER the column it just chose — while looking like it worked.
    const calls = stubFetch([
      suggestions(
        { dependencySuggestions: { FROM: [{ relationship: "implements" }] } },
        { propertySuggestions: [{ property: "Status" }] }
      ),
    ])

    const result = await callTool(TOOL_NAMES.discoverMatrixColumns, {
      ...base,
      columns: [{ type: "TO", value: "implements" }],
    })

    expect(result.isError).toBeFalsy()
    const posted = calls[0].body as { traceabilityMatrix: { columns: { step: { type: string; value: string } }[] } }
    expect(posted.traceabilityMatrix.columns.map((column) => column.step)).toEqual([
      { type: "FIRST_COLUMN", value: "" },
      { type: "TO", value: "implements" },
    ])
    // And the candidates of that second column are what the model needs to keep going.
    expect(result.content[0].text).toContain('"parent_column_index":1,"type":"PROPERTY","value":"Status"')
  })

  it("sends an empty variant list rather than a null the backend might iterate", async () => {
    const calls = stubFetch([suggestions({ propertySuggestions: [{ property: "Category" }] })])
    await callTool(TOOL_NAMES.discoverMatrixColumns, base)
    expect((calls[0].body as { traceabilityMatrix: { variants: unknown } }).traceabilityMatrix.variants).toEqual([])
  })
})
