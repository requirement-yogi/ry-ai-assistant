import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerTraceabilityTools } from "../../src/tools/traceability.js"
import { TOOL_NAMES } from "../../src/tools/toolNames.js"
import { STEP_TYPES } from "../../src/api/traceabilityDto.js"
import { resetRyClient } from "../../src/api/ryClient.js"

// The traceability tools as a CLIENT sees them, over a real (in-memory) MCP connection.
//
// First what is declared: listing the tools is what converts every inputSchema/outputSchema to JSON
// Schema, so a shape the conversion cannot express fails here rather than in front of a user. Then
// (second describe) what they DO, with only `fetch` stubbed — nothing here reaches a network.

type ListedTool = {
  name: string
  description?: string
  inputSchema: { properties?: Record<string, any>; required?: string[] }
  outputSchema?: { properties?: Record<string, unknown> }
  annotations?: Record<string, unknown>
}

let tools: Record<string, ListedTool>
let client: Client

beforeAll(async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerTraceabilityTools(server)

  client = new Client({ name: "test-client", version: "0.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const listed = (await client.listTools()).tools as ListedTool[]
  tools = Object.fromEntries(listed.map((tool) => [tool.name, tool]))
})

describe("the traceability tools", () => {
  it("exposes the four matrix tools, each with the description from its prompt file", () => {
    for (const name of [
      TOOL_NAMES.discoverMatrixColumns,
      TOOL_NAMES.saveTraceabilityMatrix,
      TOOL_NAMES.getTraceabilityMatrix,
      TOOL_NAMES.listTraceabilityMatrices,
    ]) {
      expect(tools[name], `${name} was not registered`).toBeDefined()
      expect(tools[name].description, `${name} has no description`).toBeTruthy()
    }
  })

  it("tells the model the traps in the descriptions it will actually read", () => {
    // The descriptions are the only place the model learns that the vocabulary is data-dependent and
    // that a false all* flag means "already used". Losing that turns these tools into a convenient
    // way to save matrices that render nothing.
    const discovery = tools[TOOL_NAMES.discoverMatrixColumns].description ?? ""
    expect(discovery).toContain("NEVER invent")
    expect(discovery).toMatch(/already used/i)
    expect(discovery).toMatch(/one round trip per level|call again/i)
    expect(tools[TOOL_NAMES.saveTraceabilityMatrix].description).toMatch(/re-validates/i)
  })

  it("requires exactly what a matrix cannot be built without", () => {
    const save = tools[TOOL_NAMES.saveTraceabilityMatrix]
    expect(Object.keys(save.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["space", "query", "name", "columns", "variants", "limit", "shared_level", "matrix_id"])
    )
    expect(save.inputSchema.required?.sort()).toEqual(["columns", "name", "query", "space"])
    // Discovery must be callable with no columns at all — that is step one of the loop.
    expect(tools[TOOL_NAMES.discoverMatrixColumns].inputSchema.required).toEqual(["space", "query"])
  })

  it("offers every step type EXCEPT the injected first column", () => {
    const columns = tools[TOOL_NAMES.saveTraceabilityMatrix].inputSchema.properties?.columns
    const offered: string[] = columns?.items?.properties?.type?.enum ?? []
    expect(offered).not.toContain("FIRST_COLUMN")
    expect(new Set(offered)).toEqual(new Set(STEP_TYPES.filter((type) => type !== "FIRST_COLUMN")))
  })

  it("declares a structured result on the three bounded tools", () => {
    // discover_matrix_columns deliberately has none: its payload is a whole space's vocabulary, and
    // the spec would have us serialise it into a text block too (same call as search_requirements).
    expect(tools[TOOL_NAMES.saveTraceabilityMatrix].outputSchema).toBeDefined()
    expect(tools[TOOL_NAMES.getTraceabilityMatrix].outputSchema).toBeDefined()
    expect(tools[TOOL_NAMES.listTraceabilityMatrices].outputSchema).toBeDefined()
    expect(tools[TOOL_NAMES.discoverMatrixColumns].outputSchema).toBeUndefined()
  })

  it("marks the three read tools read-only and the saving one as a write", () => {
    for (const name of [
      TOOL_NAMES.discoverMatrixColumns,
      TOOL_NAMES.getTraceabilityMatrix,
      TOOL_NAMES.listTraceabilityMatrices,
    ]) {
      expect(tools[name].annotations?.readOnlyHint, name).toBe(true)
    }
    // Saving is additive (or replaces the matrix whose id was given), never destructive — but
    // calling it twice creates two saved matrices, so it is not idempotent either.
    expect(tools[TOOL_NAMES.saveTraceabilityMatrix].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    })
  })
})

// Calling the handlers for real, over the same connection, with only `fetch` stubbed. This is what
// catches the wiring the unit tests can't see: that a declared outputSchema actually accepts the
// structuredContent the handler builds (the SDK validates it on both ends), and that the request the
// client ends up making is the one the API expects. `base_url` is passed so the client never needs to
// resolve the Confluence instance, which keeps each call to exactly the round trips under test.

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

describe("calling the traceability tools end to end", () => {
  beforeAll(() => {
    process.env.RY_DATA_RESIDENCY = "EU"
    process.env.RY_PERSONAL_ACCESS_TOKEN = "tok"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    // The shared client caches its config, so drop it with the stub it was built against.
    resetRyClient()
  })

  afterAll(() => {
    delete process.env.RY_DATA_RESIDENCY
    delete process.env.RY_PERSONAL_ACCESS_TOKEN
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

  it("sends an empty variant list rather than a null the backend might iterate", async () => {
    const calls = stubFetch([suggestions({ propertySuggestions: [{ property: "Category" }] })])
    await callTool(TOOL_NAMES.discoverMatrixColumns, base)
    expect((calls[0].body as { traceabilityMatrix: { variants: unknown } }).traceabilityMatrix.variants).toEqual([])
  })

  it("reads a saved matrix back, parsing the definition out of its json string", async () => {
    const definition = { columns: [{ columnIndex: 0, step: { type: "FIRST_COLUMN", value: null } }], query: "q", spaceKey: "DEMO" }
    stubFetch([{ body: { id: 5, name: "M", spaceKey: "DEMO", query: "q", json: JSON.stringify(definition) } }])

    const result = await callTool(TOOL_NAMES.getTraceabilityMatrix, { matrix_id: 5, base_url: base.base_url })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ id: 5, name: "M", warnings: [] })
    expect(result.structuredContent?.definition).toMatchObject({ query: "q" })
  })

  it("surfaces an unreadable saved matrix as a failure with guidance", async () => {
    stubFetch([{ body: { id: 6, json: "{not json" } }])
    const result = await callTool(TOOL_NAMES.getTraceabilityMatrix, { matrix_id: 6, base_url: base.base_url })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("not valid JSON")
    // The guidance comes from the error class, wired in by registry.ts.
    expect(result.content[0].text).toContain("check_for_updates")
  })

  it("lists saved matrices with the filters the backend requires", async () => {
    const calls = stubFetch([{ body: { results: [{ id: 1, name: "A", spaceKey: "DEMO" }], total: 1 } }])
    const result = await callTool(TOOL_NAMES.listTraceabilityMatrices, { space: "DEMO", base_url: base.base_url })

    expect(result.structuredContent).toMatchObject({ total: 1, returned: 1, offset: 0 })
    // `owned` is required by RYEntityFilters, and the default keeps the list to traceability matrices.
    expect(calls[0].body).toEqual({ owned: true, spaceKey: "DEMO", matrixType: "TRACEABILITY" })
  })
})
