import { describe, it, expect } from "vitest"
import {
  ApplicationSchema,
  OrganizationSchema,
  RequirementSchema,
  SearchPageSchema,
  isActiveConfluenceApplication,
  parseApi,
  parseApiItems,
  propertyLabel,
  relationshipName,
} from "../../src/api/dto.js"
import { RyResponseError } from "../../src/errors.js"

// These schemas guard the frontier with an API whose exact shape is still being confirmed. The
// balance they have to strike: tolerate everything we merely haven't catalogued (unknown fields,
// absent optional ones) while still failing loudly on something genuinely wrong. Both halves are
// tested here, because a schema that is too strict breaks a working integration and one that is
// too loose puts us back to silent undefineds.

describe("leniency", () => {
  it("keeps fields the schema doesn't declare, instead of stripping them", () => {
    const application = ApplicationSchema.parse({ id: 1, type: "JIRA", somethingNew: "keep me" })
    expect((application as Record<string, unknown>).somethingNew).toBe("keep me")
  })

  it("tolerates an unknown application type rather than rejecting the whole list", () => {
    expect(ApplicationSchema.parse({ id: 1, type: "BITBUCKET" }).type).toBe("BITBUCKET")
  })

  it("accepts null for optional fields — the API sends both null and absent", () => {
    expect(RequirementSchema.parse({ id: 1, key: null, text: undefined }).key).toBeNull()
  })

  it("accepts a requirement with nothing but the fields it happens to have", () => {
    expect(() => RequirementSchema.parse({})).not.toThrow()
  })
})

describe("strictness", () => {
  it("rejects an id that is not a number", () => {
    expect(OrganizationSchema.safeParse({ id: "12" }).success).toBe(false)
  })

  it("rejects an item that is not an object at all", () => {
    expect(ApplicationSchema.safeParse("nope").success).toBe(false)
  })
})

describe("parseApi", () => {
  it("returns the parsed payload on success", () => {
    const page = parseApi(SearchPageSchema, { results: [{ id: 1 }], total: 1 }, "GET /rest/search")
    expect(page.total).toBe(1)
    expect(page.results?.[0].id).toBe(1)
  })

  it("throws a located RyResponseError when the ENVELOPE itself is the wrong shape", () => {
    let thrown: unknown
    try {
      // A string where the endpoint should return the { results, total, … } object: a wholesale
      // mismatch, not a single odd item — this is the loud-failure case.
      parseApi(SearchPageSchema, "not-an-object", "GET /rest/search")
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RyResponseError)
    expect((thrown as Error).message).toContain("GET /rest/search")
  })

  it("points at an out-of-date MCP rather than blaming the user", () => {
    const error = new RyResponseError("x", "GET /applications")
    expect(error.guidance).toMatch(/check_for_updates/)
  })
})

describe("parseApiItems", () => {
  // One odd row on a still-unconfirmed endpoint must not take the whole list down: for /applications
  // that would sink base-URL resolution and every Confluence call after it. So a wrong-typed item is
  // DROPPED, not thrown, and the good ones survive.
  it("drops a single malformed item and keeps the rest instead of throwing", () => {
    const items = parseApiItems(
      ApplicationSchema,
      [{ id: 1 }, { id: "not-a-number" }, { id: 3 }],
      "GET /applications"
    )
    expect(items.map((item) => item.id)).toEqual([1, 3])
  })

  it("returns an empty list (never throws) when every item is malformed", () => {
    expect(parseApiItems(ApplicationSchema, ["nope", { id: {} }], "GET /applications")).toEqual([])
  })

  it("keeps a well-formed list untouched", () => {
    expect(parseApiItems(ApplicationSchema, [{ id: 1 }, { id: 2 }], "GET /applications")).toHaveLength(2)
  })
})

describe("lenient search results", () => {
  it("drops a malformed requirement without sinking the whole page", () => {
    const page = parseApi(
      SearchPageSchema,
      { results: [{ id: 1 }, { id: "bad" }, { id: 3 }], total: 3 },
      "GET /rest/search"
    )
    expect(page.results?.map((requirement) => requirement.id)).toEqual([1, 3])
    expect(page.total).toBe(3) // the envelope is untouched
  })
})

describe("field accessors", () => {
  it("resolves a property label across the API's three spellings", () => {
    expect(propertyLabel({ label: "Priority" })).toBe("Priority")
    expect(propertyLabel({ name: "Status" })).toBe("Status")
    expect(propertyLabel({ key: "Category" })).toBe("Category")
    expect(propertyLabel({ label: "  Spaced  " })).toBe("Spaced")
    expect(propertyLabel({})).toBeUndefined()
    expect(propertyLabel({ label: "   " })).toBeUndefined()
  })

  it("falls through a present-but-empty spelling to a later real one", () => {
    // The API can send an empty `label` alongside a real `name`/`key`. A `??` chain would stop at
    // the "" and drop the real value; the fallback must skip empty spellings, not just missing ones.
    expect(propertyLabel({ label: "", name: "Status" })).toBe("Status")
    expect(propertyLabel({ label: "   ", key: "Category" })).toBe("Category")
    expect(propertyLabel({ label: "", name: "", key: "Category" })).toBe("Category")
  })

  it("resolves a relationship name from either spelling", () => {
    expect(relationshipName({ id: 1, name: "implements" })).toBe("implements")
    expect(relationshipName({ id: 1, label: "is tested by" })).toBe("is tested by")
    expect(relationshipName({ id: 1 })).toBeUndefined()
  })

  it("falls through an empty relationship name to the label", () => {
    expect(relationshipName({ id: 1, name: "", label: "is tested by" })).toBe("is tested by")
  })

  it("only treats an ACTIVE CONFLUENCE application as a base-URL candidate", () => {
    expect(isActiveConfluenceApplication({ id: 1, type: "CONFLUENCE", status: "ACTIVE" })).toBe(true)
    expect(isActiveConfluenceApplication({ id: 1, type: "CONFLUENCE", status: "DISABLED" })).toBe(false)
    expect(isActiveConfluenceApplication({ id: 1, type: "JIRA", status: "ACTIVE" })).toBe(false)
    expect(isActiveConfluenceApplication({ id: 1 })).toBe(false)
  })
})
