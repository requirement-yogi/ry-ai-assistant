import { describe, it, expect } from "vitest"
import { collectProperties, listSearchableFields, type SchemaGroundingApi } from "../../src/services/schemaGrounding.js"
import { RequirementSchema, type Requirement, type SearchPage } from "../../src/api/dto.js"

// The point of schema grounding is that the LLM only ever writes field names that really exist.
// If collectProperties misses a spelling the API uses, a real property silently disappears from
// list_searchable_fields and the model goes back to guessing.

const requirement = (properties: unknown[]): Requirement =>
  RequirementSchema.parse({ id: 1, properties })

describe("collectProperties", () => {
  it("accepts the three spellings the API uses for a property name", () => {
    const plain = new Set<string>()
    const external = new Set<string>()
    collectProperties(
      requirement([
        { label: "Priority", value: "High" },
        { name: "Status", value: "Open" },
        { key: "Category", value: "A" },
      ]),
      plain,
      external
    )
    expect([...plain].sort()).toEqual(["Category", "Priority", "Status"])
    expect(external.size).toBe(0)
  })

  it("routes external properties to the ext@ bucket, whichever flag marks them", () => {
    const plain = new Set<string>()
    const external = new Set<string>()
    collectProperties(
      requirement([
        { label: "Score", value: "3", external: true },
        { label: "Weight", value: "2", isExternal: true },
        { label: "Rank", value: "1", ext: true },
      ]),
      plain,
      external
    )
    expect([...external].sort()).toEqual(["Rank", "Score", "Weight"])
    expect(plain.size).toBe(0)
  })

  it("trims whitespace so the same property never appears twice", () => {
    const plain = new Set<string>()
    collectProperties(requirement([{ label: "  Priority  " }, { label: "Priority" }]), plain, new Set())
    expect([...plain]).toEqual(["Priority"])
  })

  it("skips entries with no usable name", () => {
    const plain = new Set<string>()
    const external = new Set<string>()
    collectProperties(requirement([{ value: "x" }, { label: "   " }]), plain, external)
    expect(plain.size + external.size).toBe(0)
  })

  it("handles a requirement with no properties at all", () => {
    const plain = new Set<string>()
    collectProperties(RequirementSchema.parse({ id: 1 }), plain, new Set())
    collectProperties(RequirementSchema.parse({ id: 1, properties: null }), plain, new Set())
    expect(plain.size).toBe(0)
  })
})

// The sampling loop is what makes list_searchable_fields cheap enough to call speculatively before
// every query. It is driven here through a fake client — the service takes one precisely so this
// can be tested without a network.

type FakeOptions = { pages: SearchPage[]; relationships?: unknown[]; relationshipsError?: Error }

function fakeApi({ pages, relationships = [], relationshipsError }: FakeOptions) {
  const calls: { offset?: number }[] = []
  const api: SchemaGroundingApi = {
    async listAllRelationships() {
      if (relationshipsError) throw relationshipsError
      return relationships as never
    },
    async searchRequirements(options) {
      calls.push({ offset: options.offset })
      return pages[calls.length - 1] ?? { results: [], hasNext: false }
    },
  }
  return { api, calls }
}

const withProperties = (...labels: string[]) => ({ properties: labels.map((label) => ({ label })) })

describe("listSearchableFields", () => {
  it("returns the real identifiers of the space, sorted and de-duplicated", async () => {
    const { api } = fakeApi({
      pages: [{ results: [withProperties("Priority", "Owner"), withProperties("Owner")], hasNext: false }],
      relationships: [{ id: 1, name: "implements" }, { id: 2, label: "is tested by" }],
    })

    const fields = await listSearchableFields({ spaceKey: "DEMO", api })
    expect(fields.space).toBe("DEMO")
    expect(fields.properties).toEqual(["Owner", "Priority"])
    expect(fields.relationships).toEqual(["implements", "is tested by"])
    expect(fields.sampled).toBe(2)
  })

  it("follows hasNext, advancing the offset by what it actually received", async () => {
    const { api, calls } = fakeApi({
      pages: [
        { results: [withProperties("A"), withProperties("B")], hasNext: true },
        { results: [withProperties("C")], hasNext: false },
      ],
    })

    const fields = await listSearchableFields({ spaceKey: "DEMO", api })
    expect(calls.map((call) => call.offset)).toEqual([0, 2])
    expect(fields.properties).toEqual(["A", "B", "C"])
  })

  it("stops at the sample cap and says so, instead of walking a huge space", async () => {
    const fullPage = { results: Array.from({ length: 200 }, () => withProperties("P")), hasNext: true }
    const { api, calls } = fakeApi({ pages: Array.from({ length: 20 }, () => fullPage) })

    const fields = await listSearchableFields({ spaceKey: "BIG", api })
    expect(fields.sampled).toBe(1000)
    expect(calls).toHaveLength(5)
    expect(fields.notes.some((note) => note.includes("sampled from the first 1000"))).toBe(true)
  })

  it("still returns the properties when the relationships lookup fails", async () => {
    // Relationships come from a different API with its own auth; a failure there (typically
    // "applicationId required") must not cost the model its property names.
    const { api } = fakeApi({
      pages: [{ results: [withProperties("Priority")], hasNext: false }],
      relationshipsError: new Error("applicationId is required"),
    })

    const fields = await listSearchableFields({ spaceKey: "DEMO", api })
    expect(fields.properties).toEqual(["Priority"])
    expect(fields.relationships).toEqual([])
    expect(fields.notes.some((note) => note.includes("applicationId is required"))).toBe(true)
  })

  it("warns rather than staying silent when a category surfaced nothing", async () => {
    const { api } = fakeApi({ pages: [{ results: [withProperties("P")], hasNext: false }] })
    const fields = await listSearchableFields({ spaceKey: "DEMO", api })
    expect(fields.notes.some((note) => note.includes("default variant 'Current'"))).toBe(true)
    expect(fields.notes.some((note) => note.includes("best-effort"))).toBe(true)
  })

  it("copes with a space that has no requirements yet", async () => {
    const { api } = fakeApi({ pages: [{ results: [], hasNext: false }] })
    const fields = await listSearchableFields({ spaceKey: "EMPTY", api })
    expect(fields.sampled).toBe(0)
    expect(fields.properties).toEqual([])
  })
})
