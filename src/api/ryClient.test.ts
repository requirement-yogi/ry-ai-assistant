import { describe, it, expect } from "vitest"
import { extractItems, pageTotal, collectProperties } from "./ryClient.js"

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

describe("collectProperties", () => {
  it("collects labels and classifies external vs plain", () => {
    const plain = new Set<string>()
    const external = new Set<string>()
    collectProperties(
      {
        properties: [
          { label: "Priority", value: "High" },
          { name: "Status", value: "Open" },
          { key: "Category", value: "A" },
          { label: "Score", value: "3", external: true },
          { label: "Weight", value: "2", isExternal: true },
          { label: "Rank", value: "1", ext: true },
        ],
      },
      plain,
      external
    )
    expect([...plain].sort()).toEqual(["Category", "Priority", "Status"])
    expect([...external].sort()).toEqual(["Rank", "Score", "Weight"])
  })

  it("ignores entries without a usable label and non-array properties", () => {
    const plain = new Set<string>()
    const external = new Set<string>()
    collectProperties({ properties: [{ value: "x" }, "nope", null, 5] }, plain, external)
    collectProperties({ properties: "not-an-array" }, plain, external)
    collectProperties({}, plain, external)
    expect(plain.size).toBe(0)
    expect(external.size).toBe(0)
  })

  it("trims whitespace on labels", () => {
    const plain = new Set<string>()
    const external = new Set<string>()
    collectProperties({ properties: [{ label: "  Priority  " }] }, plain, external)
    expect([...plain]).toEqual(["Priority"])
  })
})
