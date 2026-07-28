import { describe, it, expect, afterEach, vi } from "vitest"
import { extractItems, pageTotal, resetRyClient, ryClient, RyClient } from "../../src/api/ryClient.js"
import { RyAmbiguityError, RyApiError, RyConfigError, RyConnectionError, RyResponseError } from "../../src/errors.js"

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
  const calls: { url: string; headers: Record<string, string>; method: string }[] = []
  let call = 0
  const fetchStub = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: init.headers as Record<string, string>, method: init.method ?? "GET" })
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
