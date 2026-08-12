import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerSaveTraceabilityMatrixTool } from "../../../src/features/save_traceability_matrix/tool.js"
import { TOOL_NAMES } from "../../../src/prompts/index.generated.js"
import { STEP_TYPES } from "../../../src/shared/traceability/dto.js"
import { resetRyClient } from "../../../src/core/api/ryClient.js"

// save_traceability_matrix as a CLIENT sees it, over a real (in-memory) MCP connection.
//
// First what is declared: listing the tool is what converts its inputSchema/outputSchema to JSON
// Schema, so a shape the conversion cannot express fails here rather than in front of a user. Then
// (second describe) what it DOES, with only `fetch` stubbed — nothing here reaches a network.

type ListedTool = {
  name: string
  description?: string
  inputSchema: { properties?: Record<string, any>; required?: string[] }
  outputSchema?: { properties?: Record<string, unknown> }
  annotations?: Record<string, unknown>
}

let tool: ListedTool
let client: Client

beforeAll(async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerSaveTraceabilityMatrixTool(server)

  client = new Client({ name: "test-client", version: "0.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const listed = (await client.listTools()).tools as ListedTool[]
  tool = listed.find((t) => t.name === TOOL_NAMES.saveTraceabilityMatrix)!
})

describe("save_traceability_matrix", () => {
  it("is registered with a description from its prompt file", () => {
    expect(tool).toBeDefined()
    expect(tool.description).toBeTruthy()
    expect(tool.description).toMatch(/re-validates/i)
  })

  it("requires exactly what a matrix cannot be built without", () => {
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["space", "query", "name", "columns", "variants", "limit", "shared_level", "matrix_id"])
    )
    expect(tool.inputSchema.required?.sort()).toEqual(["columns", "name", "query", "space"])
  })

  it("offers every step type EXCEPT the injected first column", () => {
    const columns = tool.inputSchema.properties?.columns
    const offered: string[] = columns?.items?.properties?.type?.enum ?? []
    expect(offered).not.toContain("FIRST_COLUMN")
    expect(new Set(offered)).toEqual(new Set(STEP_TYPES.filter((type) => type !== "FIRST_COLUMN")))
  })

  it("declares a structured result", () => {
    expect(tool.outputSchema).toBeDefined()
  })

  it("is a write, additive or replacing, but never idempotent", () => {
    // Saving is additive (or replaces the matrix whose id was given), never destructive — but
    // calling it twice creates two saved matrices, so it is not idempotent either.
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    })
  })
})

// Calling the handler for real, over the same connection, with only `fetch` stubbed. This is what
// catches the wiring the unit tests can't see: that a declared outputSchema actually accepts the
// structuredContent the handler builds (the SDK validates it on both ends), and that the request the
// client ends up making is the one the API expects. `base_url` is passed so the client never needs to
// resolve the Confluence instance, which keeps each call to exactly the round trips under test.

type Reply = { status?: number; body?: unknown }

function stubFetch(replies: Reply[]) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  let call = 0
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
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

describe("calling save_traceability_matrix end to end", () => {
  beforeAll(() => {
    process.env.RY_DATA_RESIDENCY = "EU"
    process.env.RY_PERSONAL_ACCESS_TOKEN = "tok"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetRyClient()
  })

  const suggestions = (...entries: unknown[]) => ({ body: { columnSuggestions: entries } })
  const base = { space: "DEMO", query: "key ~ 'FN-%'", base_url: "https://acme.atlassian.net" }

  it("validates then writes, and reports the saved matrix", async () => {
    const calls = stubFetch([
      suggestions({ propertySuggestions: [{ property: "Priority" }] }), // probe for column 1
      { body: { id: 314 } }, // POST /rest/saved-matrices
    ])

    const result = await callTool(TOOL_NAMES.saveTraceabilityMatrix, {
      ...base,
      name: "Priority coverage",
      columns: [{ type: "PROPERTY", value: "Priority", label: "How urgent" }],
    })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ saved: true, matrix_id: 314 })
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /rest/traceability/DEMO",
      "POST /rest/saved-matrices",
    ])
    // The definition really travels as a string, with the query in both places.
    const payload = calls[1].body as { json: string; query: string }
    expect(typeof payload.json).toBe("string")
    const definition = JSON.parse(payload.json)
    expect(definition.query).toBe(payload.query)
    expect(definition.columns.map((column: { step: { type: string } }) => column.step.type)).toEqual([
      "FIRST_COLUMN",
      "PROPERTY",
    ])
  })

  it("refuses an unsupported column as an error, without writing anything", async () => {
    const calls = stubFetch([suggestions({ propertySuggestions: [{ property: "Priority" }] })])

    const result = await callTool(TOOL_NAMES.saveTraceabilityMatrix, {
      ...base,
      name: "Broken",
      columns: [{ type: "PROPERTY", value: "Invented" }],
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Nothing was saved")
    // Only the probe happened — no POST to /rest/saved-matrices.
    expect(calls).toHaveLength(1)
  })

  it("rejects an impossible column tree before spending a round trip", async () => {
    const calls = stubFetch([])
    const result = await callTool(TOOL_NAMES.saveTraceabilityMatrix, {
      ...base,
      name: "Bad tree",
      columns: [{ type: "DESCRIPTION", parent_column_index: 5 }],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("parent_column_index 5")
    expect(calls).toEqual([])
  })

  it("grows the pagination cursors as the validated matrix grows", async () => {
    // The validation walk POSTs a wider matrix each time, and the server indexes
    // columnsPagination by columnIndex — so the cursor list has to grow with it. A fixed (or empty)
    // list works for the first probe and blows up on a later one, which is exactly how this failed
    // against a real instance.
    const calls = stubFetch([
      suggestions({ propertySuggestions: [{ property: "Category" }], hasJiraLinks: true }),
      suggestions({ propertySuggestions: [{ property: "Category" }], hasJiraLinks: true }, {}),
      { body: { id: 1 } },
    ])

    const result = await callTool(TOOL_NAMES.saveTraceabilityMatrix, {
      ...base,
      name: "Two columns",
      columns: [{ type: "PROPERTY", value: "Category" }, { type: "JIRA" }],
    })

    expect(result.isError).toBeFalsy()
    const cursorCounts = calls
      .filter((call) => call.url.includes("/rest/traceability/"))
      .map((call) => (call.body as { pagination: { columnsPagination: unknown[] } }).pagination.columnsPagination.length)
    expect(cursorCounts).toEqual([1, 2])
  })

  it("does not tell the model to retry a 500 from the generation endpoint", async () => {
    // That endpoint reports a payload it cannot handle as a bare 500 (an unhandled server exception),
    // so the generic "5xx is usually transient — retry shortly" guidance would send the model into a
    // pointless retry loop. The tool-specific guidance has to override it.
    const calls = stubFetch([
      { status: 500, body: { message: "An unexpected error has occurred.", statusCode: "INTERNAL_SERVER_ERROR", errors: [] } },
    ])

    const result = await callTool(TOOL_NAMES.saveTraceabilityMatrix, {
      ...base,
      name: "Server error",
      columns: [{ type: "PROPERTY", value: "Category" }],
    })

    expect(result.isError).toBe(true)
    const text = result.content[0].text
    // The server's own body survives verbatim — it is what the user has to report.
    expect(text).toContain("An unexpected error has occurred")
    expect(text).toContain("IGNORE the generic advice above about retrying")
    expect(text).toContain("before the columns are even looked at")
    // And nothing was written.
    expect(calls).toHaveLength(1)
  })
})
