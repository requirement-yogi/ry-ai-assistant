import { describe, it, expect } from "vitest"
import { summarizeSearchPage, formatBulkLinkResult, SelectionSchema } from "./jiraLinks.js"

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

  it("falls back to the page length when total is missing, and omits absent feedback fields", () => {
    const result = summarizeSearchPage({ results: [{ id: 1 }, { id: 2 }] }) as Record<string, unknown>
    expect(result.total_count).toBe(2)
    expect(result.returned).toBe(2)
    expect("humanReadable" in result).toBe(false)
    expect("messageBean" in result).toBe(false)
  })

  it("drops undefined/null fields from each requirement summary", () => {
    const result = summarizeSearchPage({ results: [{ id: 1, key: null, text: undefined }] }) as {
      requirements: Record<string, unknown>[]
    }
    expect(result.requirements[0]).toEqual({ id: 1 })
  })

  it("returns the input unchanged when it is not a search page", () => {
    expect(summarizeSearchPage({ foo: "bar" })).toEqual({ foo: "bar" })
    expect(summarizeSearchPage(null)).toBeNull()
  })
})

describe("formatBulkLinkResult", () => {
  it("formats a linked-only result", () => {
    expect(formatBulkLinkResult({ linkedCount: 3, skippedCount: 0, unauthorizedCount: 0 })).toBe(
      "3 link(s) created"
    )
  })

  it("appends skipped and unauthorized counts only when positive", () => {
    expect(formatBulkLinkResult({ linkedCount: 2, skippedCount: 1, unauthorizedCount: 4 })).toBe(
      "2 link(s) created, 1 skipped (link already existed), 4 unauthorized (the user cannot read those Jira issues)"
    )
  })

  it("falls back to JSON when the shape is unexpected", () => {
    expect(formatBulkLinkResult({ weird: true })).toBe('{"weird":true}')
    expect(formatBulkLinkResult("nope")).toBe('"nope"')
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
})
