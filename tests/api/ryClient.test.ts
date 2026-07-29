import { describe, it, expect, afterEach, vi } from "vitest"
import { columnsPagination, extractItems, pageTotal, resetRyClient, ryClient, RyClient } from "../../src/api/ryClient.js"
import { RyAmbiguityError, RyApiError, RyConfigError, RyConnectionError, RyResponseError } from "../../src/errors.js"
import { BACKEND_FILLED_ACCOUNT, type MatrixDefinition } from "../../src/api/traceabilityDto.js"

describe("extractItems", () => {
  it("returns a bare array as-is", () => {
    expect(extractItems([1, 2, 3])).toEqual([1, 2, 3])
  })

  it("unwraps each known pagination property", () => {
    expect(extractItems({ results: [1] })).toEqual([1])
    expect(extractItems({ relationships: [2] })).toEqual([2])
    expect(extractItems({ applications: [3] })).toEqual([3])
    expect(extractItems({ organizations: [4] })).toEqual([4])
    expect(extractItems({ items: [5] })).toEqual([5])
    expect(extractItems({ values: [6] })).toEqual([6])
  })

  it("prefers the first matching property in priority order", () => {
    expect(extractItems({ items: ["late"], results: ["early"] })).toEqual(["early"])
  })

  it("returns [] when nothing matches or the input is not iterable", () => {
    expect(extractItems({ total: 3 })).toEqual([])
    expect(extractItems(null)).toEqual([])
    expect(extractItems(42)).toEqual([])
    expect(extractItems({ results: "not-an-array" })).toEqual([])
  })
})

describe("pageTotal", () => {
  it("reads a numeric total", () => {
    expect(pageTotal({ items: [], total: 12 })).toBe(12)
    expect(pageTotal({ total: 0 })).toBe(0)
  })

  it("returns undefined when total is missing or not a number", () => {
    expect(pageTotal({ items: [] })).toBeUndefined()
    expect(pageTotal({ total: "12" })).toBeUndefined()
    expect(pageTotal([])).toBeUndefined()
    expect(pageTotal(null)).toBeUndefined()
  })
})

// Transport-level behaviour, driven through a stubbed fetch. None of this was reachable before the
// client became a class: the caches were module-level `let`s, so the first test to resolve an
// instance poisoned every later one.

type Reply = { status?: number; body?: unknown; text?: string } | Error

function stubFetch(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string>; method: string; body?: unknown }[] = []
  let call = 0
  const fetchStub = async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    })
    const reply = replies[call++] ?? { body: [] }
    if (reply instanceof Error) throw reply
    const status = reply.status ?? 200
    // Real fetch derives text() and json() from the same body; the client reads text() and parses
    // it, so a reply that sets `body` must serialise to that same text (a `text` override wins, for
    // the non-JSON / empty-body cases).
    const text = reply.text ?? (reply.body !== undefined ? JSON.stringify(reply.body) : "")
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => JSON.parse(text),
      text: async () => text,
    } as Response
  }
  vi.stubGlobal("fetch", fetchStub)
  return calls
}

const page = (items: unknown[], total = items.length) => ({ body: { items, offset: 0, limit: 100, total } })
const client = () => new RyClient({ hosts: { confluence: "https://conf.test", standalone: "https://api.test/api" }, token: "tok" })

describe("RyClient transport", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("authenticates the standalone API with a Bearer token", async () => {
    const calls = stubFetch([page([{ id: 1 }])])
    await client().listOrganizations()
    expect(calls[0].url).toContain("https://api.test/api/organizations")
    expect(calls[0].headers.Authorization).toBe("Bearer tok")
    expect(calls[0].headers["X-Api-Key"]).toBeUndefined()
  })

  it("authenticates the Confluence API with X-Api-Key plus the instance base URL", async () => {
    const calls = stubFetch([{ body: { results: [] } }])
    await client().searchRequirements({ query: "key ~ '%'", instanceBaseUrl: "https://acme.atlassian.net" })
    expect(calls[0].headers["X-Api-Key"]).toBe("tok")
    expect(calls[0].headers["X-Base-Url"]).toBe("https://acme.atlassian.net")
    expect(calls[0].headers.Authorization).toBeUndefined()
  })

  it("keeps paging until it has everything the server said there was", async () => {
    const calls = stubFetch([page([{ id: 1 }, { id: 2 }], 3), page([{ id: 3 }], 3)])
    expect(await client().listOrganizations()).toHaveLength(3)
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toContain("offset=2")
  })

  it("stops on an empty page rather than looping forever on a wrong total", async () => {
    const calls = stubFetch([page([{ id: 1 }], 99), page([], 99)])
    expect(await client().listOrganizations()).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })

  it("turns a non-2xx into a RyApiError that relays the server's body verbatim", async () => {
    stubFetch([{ status: 400, text: "Syntax error at position 4: unexpected token" }])
    const error = await client()
      .searchRequirements({ query: "bad", instanceBaseUrl: "https://acme.atlassian.net" })
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(RyApiError)
    expect(error.status).toBe(400)
    expect(error.path).toBe("/rest/search")
    // Verbatim relay is what lets the model self-correct its RQL.
    expect(error.message).toContain("Syntax error at position 4: unexpected token")
  })

  it("turns a connection failure into a RyConnectionError naming the cause", async () => {
    const failure = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })
    stubFetch([failure])
    const error = await client().listOrganizations().catch((caught) => caught)

    expect(error).toBeInstanceOf(RyConnectionError)
    expect(error.message).toContain("ECONNREFUSED")
  })

  it("treats an empty-body link success as a success, not a parse failure", async () => {
    // The link service can answer a created link with 204 (or 200 + empty body). Feeding that null
    // through the strict result schema would wrongly report a link that WAS created as failed.
    for (const reply of [{ status: 204 }, { status: 200, text: "" }] as const) {
      stubFetch([reply])
      const result = await client().createJiraLinks(
        {
          selection: { containerId: 1, variantId: 2, selectedRequirementIds: [1], excludedRequirementIds: [], selectAll: false },
          jiraApplicationId: 7,
          issueIds: [100],
          relationshipId: 42,
        },
        "https://acme.atlassian.net"
      )
      expect(result).toEqual({})
      vi.unstubAllGlobals()
    }
  })

  it("surfaces a non-JSON 2xx body as a located RyResponseError, not a raw SyntaxError", async () => {
    stubFetch([{ status: 200, text: "<html>gateway</html>" }])
    const error = await client()
      .searchRequirements({ query: "a", instanceBaseUrl: "https://acme.atlassian.net" })
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(RyResponseError)
    expect(error.message).toContain("/rest/search")
  })

  it("resolves the Confluence instance once and reuses it", async () => {
    const calls = stubFetch([
      page([{ id: 1 }]), // /organizations
      page([{ id: 2, type: "CONFLUENCE", status: "ACTIVE", baseUrl: "https://acme.atlassian.net" }]), // /applications
      { body: { results: [] } },
      { body: { results: [] } },
    ])
    const ry = client()
    await ry.searchRequirements({ query: "a" })
    await ry.searchRequirements({ query: "b" })

    expect(calls.filter((c) => c.url.includes("/applications"))).toHaveLength(1)
    expect(calls.at(-1)!.headers["X-Base-Url"]).toBe("https://acme.atlassian.net")
  })

  it("asks the user to choose when several Confluence instances are connected", async () => {
    stubFetch([
      page([{ id: 1 }]),
      page([
        { id: 2, type: "CONFLUENCE", status: "ACTIVE", baseUrl: "https://a.atlassian.net" },
        { id: 3, type: "CONFLUENCE", status: "ACTIVE", baseUrl: "https://b.atlassian.net" },
      ]),
    ])
    const error = await client().searchRequirements({ query: "a" }).catch((caught) => caught)
    expect(error).toBeInstanceOf(RyAmbiguityError)
    expect(error.message).toContain("https://b.atlassian.net")
  })

  it("reports a config problem, not an ambiguity, when no Confluence instance is connected", async () => {
    // Zero candidates is a different failure from several: there is nothing for the user to pick,
    // so the guidance must be "set up the integration" (RyConfigError), not "which one?".
    stubFetch([
      page([{ id: 1 }]),
      page([{ id: 2, type: "JIRA", status: "ACTIVE", baseUrl: "https://jira.atlassian.net" }]),
    ])
    const error = await client().searchRequirements({ query: "a" }).catch((caught) => caught)
    expect(error).toBeInstanceOf(RyConfigError)
    expect(error).not.toBeInstanceOf(RyAmbiguityError)
  })

  it("ignores non-Confluence and inactive applications when resolving the instance", async () => {
    const calls = stubFetch([
      page([{ id: 1 }]),
      page([
        { id: 2, type: "JIRA", status: "ACTIVE", baseUrl: "https://jira.atlassian.net" },
        { id: 3, type: "CONFLUENCE", status: "DISABLED", baseUrl: "https://old.atlassian.net" },
        { id: 4, type: "CONFLUENCE", status: "ACTIVE", baseUrl: "https://live.atlassian.net" },
      ]),
      { body: { results: [] } },
    ])
    await client().searchRequirements({ query: "a" })
    expect(calls.at(-1)!.headers["X-Base-Url"]).toBe("https://live.atlassian.net")
  })

  it("gives each client its own caches", async () => {
    const calls = stubFetch([
      page([{ id: 1 }]),
      page([{ id: 2, type: "CONFLUENCE", status: "ACTIVE", baseUrl: "https://first.atlassian.net" }]),
      { body: { results: [] } },
      page([{ id: 1 }]),
      page([{ id: 9, type: "CONFLUENCE", status: "ACTIVE", baseUrl: "https://second.atlassian.net" }]),
      { body: { results: [] } },
    ])

    await client().searchRequirements({ query: "a" })
    await client().searchRequirements({ query: "a" })

    // A second client resolves its own instance instead of inheriting the first one's — which is
    // exactly what module-level caches made impossible, and what made these tests order-dependent.
    const baseUrls = calls.filter((c) => c.url.includes("/rest/search")).map((c) => c.headers["X-Base-Url"])
    expect(baseUrls).toEqual(["https://first.atlassian.net", "https://second.atlassian.net"])
    expect(calls.filter((c) => c.url.includes("/applications"))).toHaveLength(2)
  })
})

// The traceability endpoints live on the Confluence API, and two of them have a payload shape that
// is easy to get subtly wrong (the generation envelope, and `json` being a string).

const definition = (overrides: Partial<MatrixDefinition> = {}): MatrixDefinition => ({
  columns: [
    { label: "Requirement", step: { type: "FIRST_COLUMN", value: "" }, columnIndex: 0, parentColumnIndex: 0, hidden: false },
  ],
  query: "key ~ 'FN-%'",
  variants: [],
  limit: 200,
  spaceKey: "DEMO",
  ...overrides,
})

// The backend reads columnsPagination.get(column.columnIndex).lastCellId for every column, so a
// short array is an IndexOutOfBoundsException on the server — surfacing as a bare 500 that says
// nothing about the payload. Getting the SIZE right is the whole contract of this helper.
describe("columnsPagination", () => {
  const columns = (...indexes: number[]): MatrixDefinition =>
    definition({
      columns: indexes.map((columnIndex) => ({
        label: `c${columnIndex}`,
        step: { type: "PROPERTY" as const, value: "P" },
        columnIndex,
        parentColumnIndex: 0,
        hidden: false,
      })),
    })

  it("carries exactly one cursor per column", () => {
    expect(columnsPagination(columns(0))).toEqual([{ lastCellId: null }])
    expect(columnsPagination(columns(0, 1, 2))).toHaveLength(3)
  })

  it("is never shorter than the highest column index, whatever the column order", () => {
    // Sized off the indexes rather than the array length: get(columnIndex) is what the server calls,
    // so an out-of-order (or sparse) definition still has to be addressable at its highest index.
    expect(columnsPagination(columns(2, 0, 1))).toHaveLength(3)
    expect(columnsPagination(columns(0, 3))).toHaveLength(4)
  })

  it("is empty only for a matrix with no columns at all", () => {
    expect(columnsPagination(definition({ columns: [] }))).toEqual([])
  })
})

describe("RyClient traceability endpoints", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("sends one pagination cursor per column, so the server can index into it", async () => {
    const calls = stubFetch([{ body: { columnSuggestions: [] } }])
    await client().generateTraceabilityMatrix({
      matrix: definition({
        columns: [
          { label: "Requirement", step: { type: "FIRST_COLUMN", value: "" }, columnIndex: 0, parentColumnIndex: 0, hidden: false },
          { label: "Category", step: { type: "PROPERTY", value: "Category" }, columnIndex: 1, parentColumnIndex: 0, hidden: false },
        ],
      }),
      instanceBaseUrl: "https://acme.atlassian.net",
    })
    const { pagination } = calls[0].body as { pagination: { columnsPagination: unknown[] } }
    expect(pagination.columnsPagination).toEqual([{ lastCellId: null }, { lastCellId: null }])
  })

  it("posts the generation envelope the API expects, at the space's own path", async () => {
    const calls = stubFetch([{ body: { columnSuggestions: [{ description: true }] } }])
    const result = await client().generateTraceabilityMatrix({
      matrix: definition({ spaceKey: "MY SPACE" }),
      variableValues: { release: "1.2" },
      instanceBaseUrl: "https://acme.atlassian.net",
    })

    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toBe("https://conf.test/rest/traceability/MY%20SPACE")
    expect(calls[0].headers["X-Api-Key"]).toBe("tok")
    expect(calls[0].body).toEqual({
      traceabilityMatrix: definition({ spaceKey: "MY SPACE" }),
      // The suggestions are derived from the requirements this page returns, so the page size is
      // driven by the definition's own limit rather than a second, independent knob. columnsPagination
      // carries one cursor per column — see the columnsPagination tests.
      pagination: { searchOffset: 0, limit: 200, columnsPagination: [{ lastCellId: null }] },
      variableValues: { release: "1.2" },
    })
    expect(result.columnSuggestions).toEqual([{ description: true }])
  })

  it("sends an empty variableValues rather than omitting it", async () => {
    const calls = stubFetch([{ body: { columnSuggestions: [] } }])
    await client().generateTraceabilityMatrix({ matrix: definition(), instanceBaseUrl: "https://acme.atlassian.net" })
    expect((calls[0].body as { variableValues: unknown }).variableValues).toEqual({})
  })

  it("keeps the suggestion array positional instead of dropping odd entries", async () => {
    // columnSuggestions is indexed BY COLUMN: dropping a malformed entry the way the item-level
    // leniency does elsewhere would shift every later index onto the wrong parent column.
    stubFetch([{ body: { columnSuggestions: [{ description: true }, {}, { links: true }] } }])
    const result = await client().generateTraceabilityMatrix({
      matrix: definition(),
      instanceBaseUrl: "https://acme.atlassian.net",
    })
    expect(result.columnSuggestions).toHaveLength(3)
    expect(result.columnSuggestions?.[2]).toEqual({ links: true })
  })

  it("creates a saved matrix with the definition serialised as a string", async () => {
    const calls = stubFetch([{ body: { id: 42 } }])
    const saved = await client().createSavedMatrix(
      {
        name: "Matrix",
        spaceKey: "DEMO",
        type: "TRACEABILITY",
        json: JSON.stringify(definition()),
        query: "key ~ 'FN-%'",
        sharedLevel: "NONE",
        status: "ACTIVE",
      },
      "https://acme.atlassian.net"
    )

    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toBe("https://conf.test/rest/saved-matrices")
    const body = calls[0].body as { json: unknown; query: string }
    expect(typeof body.json).toBe("string")
    expect(JSON.parse(body.json as string).query).toBe(body.query)
    expect(saved.id).toBe(42)
  })

  it("treats an empty-body write as a success with no id", async () => {
    stubFetch([{ status: 204 }])
    const saved = await client().createSavedMatrix(
      { name: "M", spaceKey: "DEMO", type: "TRACEABILITY", json: "{}", query: "q", sharedLevel: "NONE", status: "ACTIVE" },
      "https://acme.atlassian.net"
    )
    expect(saved).toEqual({})
  })

  it("puts the id in both the path and the body when updating", async () => {
    const calls = stubFetch([{ body: { id: 7 } }])
    await client().updateSavedMatrix(
      7,
      { name: "M", spaceKey: "DEMO", type: "TRACEABILITY", json: "{}", query: "q", sharedLevel: "NONE", status: "ACTIVE" },
      "https://acme.atlassian.net"
    )
    expect(calls[0].method).toBe("PUT")
    expect(calls[0].url).toBe("https://conf.test/rest/saved-matrices/7")
    expect((calls[0].body as { id: number }).id).toBe(7)
  })

  it("tells the backend to fill the owner in itself on EVERY write", async () => {
    // Both writes carry the sentinel; a client must never send a real account id, which would amount
    // to reassigning ownership. Injected by the transport, so no caller can omit it or replace it —
    // which is also why `ownerAccountId` is not a field of SavedMatrixPayload.
    const payload = {
      name: "M",
      spaceKey: "DEMO",
      type: "TRACEABILITY",
      json: "{}",
      query: "q",
      sharedLevel: "NONE",
      status: "ACTIVE",
    } as const

    expect(BACKEND_FILLED_ACCOUNT).toBe("FILLED_IN_BACKEND")

    const created = stubFetch([{ body: { id: 42 } }])
    await client().createSavedMatrix(payload, "https://acme.atlassian.net")
    expect((created[0].body as { ownerAccountId: string }).ownerAccountId).toBe(BACKEND_FILLED_ACCOUNT)
    // A create carries no id — that one is only in the body of an update.
    expect(created[0].body).not.toHaveProperty("id")
    vi.unstubAllGlobals()

    const updated = stubFetch([{ body: { id: 7 } }])
    await client().updateSavedMatrix(7, payload, "https://acme.atlassian.net")
    expect((updated[0].body as { ownerAccountId: string }).ownerAccountId).toBe(BACKEND_FILLED_ACCOUNT)
    expect((updated[0].body as { id: number }).id).toBe(7)
  })

  it("searches saved matrices with the filters in the body and the paging in the query", async () => {
    const calls = stubFetch([{ body: { results: [{ id: 1 }, { id: 2 }], total: 9 } }])
    const page = await client().searchSavedMatrices({
      filters: { owned: true, spaceKey: "DEMO" },
      offset: 50,
      limit: 25,
      instanceBaseUrl: "https://acme.atlassian.net",
    })
    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toContain("/rest/saved-matrices/search?offset=50&limit=25")
    expect(calls[0].body).toEqual({ owned: true, spaceKey: "DEMO" })
    expect(page).toEqual({ items: [{ id: 1 }, { id: 2 }], total: 9 })
  })

  it("deletes by id and accepts the 204", async () => {
    const calls = stubFetch([{ status: 204 }])
    await expect(client().deleteSavedMatrix(5, "https://acme.atlassian.net")).resolves.toBeUndefined()
    expect(calls[0].method).toBe("DELETE")
    expect(calls[0].url).toBe("https://conf.test/rest/saved-matrices/5")
  })
})

describe("the shared client", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetRyClient()
    delete process.env.RY_PERSONAL_ACCESS_TOKEN
    delete process.env.RY_DATA_RESIDENCY
  })

  it("fails with a RyConfigError, not at import time, when the token is missing", () => {
    process.env.RY_DATA_RESIDENCY = "EU"
    expect(() => ryClient()).toThrow(RyConfigError)
  })

  it("does not cache a failed construction, so fixing the env is enough", () => {
    expect(() => ryClient()).toThrow(RyConfigError)
    process.env.RY_DATA_RESIDENCY = "EU"
    process.env.RY_PERSONAL_ACCESS_TOKEN = "tok"
    expect(ryClient()).toBeInstanceOf(RyClient)
  })

  it("returns the same instance once built", () => {
    process.env.RY_DATA_RESIDENCY = "EU"
    process.env.RY_PERSONAL_ACCESS_TOKEN = "tok"
    expect(ryClient()).toBe(ryClient())
  })
})
