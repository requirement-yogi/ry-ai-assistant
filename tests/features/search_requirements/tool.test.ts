import { describe, it, expect } from "vitest"
import { summarizeSearchPage } from "../../../src/features/search_requirements/tool.js"

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
