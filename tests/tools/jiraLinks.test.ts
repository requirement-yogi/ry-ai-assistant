import { describe, it, expect } from "vitest"
import { summarizeSearchPage, SelectionSchema } from "../../src/tools/jiraLinks.js"

describe("summarizeSearchPage", () => {
  it("trims requirements to the linking essentials and keeps the envelope", () => {
    const page = {
      results: [
        {
          id: 1,
          key: "REQ-1",
          text: "A requirement",
          applicationId: 10,
          containerId: 20,
          variantId: 30,
          status: "CURRENT",
          canonicalURL: "https://x/1",
          properties: [{ label: "Priority", value: "High" }],
          // heavy fields that must be dropped
          storage: "<huge/>",
          dependencies: [{ id: 999 }],
        },
      ],
      offset: 0,
      limit: 200,
      total: 5,
      hasNext: true,
      humanReadable: "key ~ REQ%",
      messageBean: { warnings: [] },
    }
    expect(summarizeSearchPage(page)).toEqual({
      total_count: 5,
      returned: 1,
      offset: 0,
      limit: 200,
      hasNext: true,
      humanReadable: "key ~ REQ%",
      messageBean: { warnings: [] },
      requirements: [
        {
          id: 1,
          key: "REQ-1",
          text: "A requirement",
          applicationId: 10,
          containerId: 20,
          variantId: 30,
          status: "CURRENT",
          canonicalURL: "https://x/1",
          properties: [{ label: "Priority", value: "High" }],
        },
      ],
    })
  })

  it("uses the page length as the total when total is missing AND this is the last page", () => {
    const result = summarizeSearchPage({ results: [{ id: 1 }, { id: 2 }] }) as Record<string, unknown>
    expect(result.total_count).toBe(2)
    expect(result.returned).toBe(2)
    expect("humanReadable" in result).toBe(false)
    expect("messageBean" in result).toBe(false)
  })

  it("omits total_count when total is missing and more pages exist, rather than under-reporting it", () => {
    // hasNext:true with no `total` means the page size is NOT the match count. Reporting it as the
    // total would tell the model the query is well-scoped and stop it paginating.
    const result = summarizeSearchPage({ results: [{ id: 1 }, { id: 2 }], hasNext: true }) as Record<string, unknown>
    expect("total_count" in result).toBe(false)
    expect(result.returned).toBe(2)
    expect(result.hasNext).toBe(true)
  })

  it("drops undefined/null fields from each requirement summary", () => {
    const result = summarizeSearchPage({ results: [{ id: 1, key: null, text: undefined }] }) as {
      requirements: Record<string, unknown>[]
    }
    expect(result.requirements[0]).toEqual({ id: 1 })
  })

  it("reports an empty page rather than an empty list", () => {
    // total_count is what tells the model "the query matched nothing" as opposed to "this page is
    // empty but there are more" — it must be present even with no results.
    expect(summarizeSearchPage({ results: [], total: 0 })).toMatchObject({ total_count: 0, returned: 0 })
    expect(summarizeSearchPage({})).toMatchObject({ total_count: 0, returned: 0, requirements: [] })
  })
})

describe("SelectionSchema", () => {
  const base = { container_id: 1, variant_id: 2 }

  it("accepts an explicit-id selection without a query", () => {
    const parsed = SelectionSchema.safeParse({ ...base, selected_requirement_ids: [10, 11] })
    expect(parsed.success).toBe(true)
  })

  it("rejects select_all without a query", () => {
    const parsed = SelectionSchema.safeParse({ ...base, select_all: true })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual(["query"])
    }
  })

  it("rejects select_all with a blank query", () => {
    expect(SelectionSchema.safeParse({ ...base, select_all: true, query: "   " }).success).toBe(false)
  })

  it("accepts select_all with a real query", () => {
    expect(
      SelectionSchema.safeParse({ ...base, select_all: true, query: "key ~ 'REQ-%'" }).success
    ).toBe(true)
  })

  it("rejects a non-select_all selection with a query but no explicit ids (would silently link nothing)", () => {
    // selectAll:false ignores the query server-side, so an empty id list links zero requirements
    // while reporting success — reject it here instead.
    const parsed = SelectionSchema.safeParse({ ...base, query: "key ~ 'REQ-%'" })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual(["selected_requirement_ids"])
    }
  })

  it("rejects a non-select_all selection with an empty id list", () => {
    expect(SelectionSchema.safeParse({ ...base, selected_requirement_ids: [] }).success).toBe(false)
  })
})
