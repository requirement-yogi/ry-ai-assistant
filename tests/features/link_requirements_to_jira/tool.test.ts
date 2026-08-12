import { describe, it, expect } from "vitest"
import { SelectionSchema } from "../../../src/features/link_requirements_to_jira/tool.js"

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
