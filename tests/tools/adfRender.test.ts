import { describe, it, expect } from "vitest"
import {
  renderRequirementParagraph,
  renderRequirementsTable,
  renderRequirementRows,
  buildRequirementsAdf,
} from "../../src/tools/adfRender.js"
import type { RequirementNode, RequirementsTree } from "../../src/schemas/requirements.js"

// adfRender is where the Requirement Yogi indexing intelligence lives: it decides WHICH context
// (table / paragraph / heading) each requirement lands in, and RY only indexes a macro inside one
// of those. A regression here silently produces a page whose requirements are never indexed, which
// is why these tests assert the structure rather than a snapshot.

const macroKeyOf = (node: any) => node?.attrs?.parameters?.guestParams?.reqKey
const cellTexts = (row: any) => row.content.map((c: any) => c.content[0].content.map((n: any) => n.text ?? macroKeyOf(n)))

function leaf(key: string, description: string, properties: { label: string; value: string }[] = []): RequirementNode {
  return { key, description, properties, children: [] }
}

function section(description: string, children: RequirementNode[]): RequirementNode {
  return { description, properties: [], children }
}

describe("renderRequirementParagraph", () => {
  it("puts the macro first and the description after it (PARAGRAPH context)", () => {
    const paragraph = renderRequirementParagraph({ key: "F-01", description: "The system logs in." })
    expect(paragraph.type).toBe("paragraph")
    expect(macroKeyOf(paragraph.content[0])).toBe("F-01")
    // The leading space matters: RY reads everything after the macro as the description.
    expect(paragraph.content[1]).toEqual({ type: "text", text: " The system logs in." })
  })

  it("emits the macro alone when there is no description", () => {
    const paragraph = renderRequirementParagraph({ key: "F-01", description: "" })
    expect(paragraph.content).toHaveLength(1)
    expect(macroKeyOf(paragraph.content[0])).toBe("F-01")
  })

  it("emits plain text when there is no key (nothing to index)", () => {
    const paragraph = renderRequirementParagraph({ description: "Just prose." })
    expect(paragraph.content).toEqual([{ type: "text", text: "Just prose." }])
  })
})

describe("renderRequirementsTable", () => {
  const table = renderRequirementsTable([
    leaf("F-01", "Login", [
      { label: "Priority", value: "High" },
      { label: "Owner", value: "Ada" },
    ]),
    leaf("F-02", "Logout", [
      { label: "Priority", value: "Low" },
      { label: "Owner", value: "Bob" },
    ]),
  ])

  it("starts with a header row — RY needs it to name the property columns", () => {
    expect(table.content[0].content.every((cell) => cell.type === "tableHeader")).toBe(true)
    expect(cellTexts(table.content[0])).toEqual([["Key"], ["Description"], ["Priority"], ["Owner"]])
  })

  it("lays each requirement out as macro | description | one cell per property", () => {
    expect(cellTexts(table.content[1])).toEqual([["F-01"], ["Login"], ["High"], ["Ada"]])
    expect(cellTexts(table.content[2])).toEqual([["F-02"], ["Logout"], ["Low"], ["Bob"]])
  })

  it("takes the column labels from the first row", () => {
    const mixed = renderRequirementsTable([
      leaf("F-01", "A", [{ label: "Priority", value: "High" }]),
      leaf("F-02", "B", [{ label: "Priority", value: "Low" }]),
    ])
    expect(cellTexts(mixed.content[0])).toEqual([["Key"], ["Description"], ["Priority"]])
  })

  it("leaves the key cell empty when a row has no key", () => {
    const table = renderRequirementsTable([{ description: "No key", properties: [{ label: "P", value: "v" }] }])
    expect(table.content[1].content[0].content[0].content).toEqual([])
  })
})

describe("renderRequirementRows", () => {
  it("merges consecutive rows that share the same property labels into ONE table", () => {
    const blocks = renderRequirementRows([
      leaf("F-01", "A", [{ label: "Priority", value: "High" }]),
      leaf("F-02", "B", [{ label: "Priority", value: "Low" }]),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe("table")
    expect((blocks[0] as any).content).toHaveLength(3) // header + 2 rows
  })

  it("starts a new table when the property signature changes", () => {
    const blocks = renderRequirementRows([
      leaf("F-01", "A", [{ label: "Priority", value: "High" }]),
      leaf("F-02", "B", [{ label: "Owner", value: "Ada" }]),
    ])
    expect(blocks.map((b) => b.type)).toEqual(["table", "table"])
  })

  it("renders a row without properties as a paragraph, not a one-column table", () => {
    const blocks = renderRequirementRows([leaf("F-01", "A")])
    expect(blocks.map((b) => b.type)).toEqual(["paragraph"])
  })

  it("splits a run into tables and paragraphs following the property runs", () => {
    const blocks = renderRequirementRows([
      leaf("F-01", "A", [{ label: "Priority", value: "High" }]),
      leaf("F-02", "B"),
      leaf("F-03", "C", [{ label: "Priority", value: "Low" }]),
    ])
    // The paragraph breaks the run, so F-01 and F-03 do NOT share a table even though their
    // property labels match.
    expect(blocks.map((b) => b.type)).toEqual(["table", "paragraph", "table"])
  })
})

describe("buildRequirementsAdf", () => {
  function tree(requirements: RequirementNode[], description = ""): RequirementsTree {
    return {
      version: "1.0",
      project_name: "Demo",
      description,
      created_at: "2026-01-01T00:00:00.000Z",
      requirements,
    }
  }

  it("produces a valid ADF doc envelope", () => {
    const doc = buildRequirementsAdf(tree([leaf("F-01", "A")]))
    expect(doc.version).toBe(1)
    expect(doc.type).toBe("doc")
  })

  it("opens with the project description when there is one", () => {
    const doc = buildRequirementsAdf(tree([leaf("F-01", "A")], "Intro text"))
    expect(doc.content[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: "Intro text" }] })
  })

  it("omits the intro paragraph when the description is empty", () => {
    const doc = buildRequirementsAdf(tree([leaf("F-01", "A")]))
    expect(doc.content[0].type).toBe("paragraph")
    expect(macroKeyOf((doc.content[0] as any).content[0])).toBe("F-01")
  })

  it("renders a node with children as a section heading and NO macro", () => {
    const doc = buildRequirementsAdf(tree([section("Authentication", [leaf("F-01", "Login")])]))
    const [heading, requirement] = doc.content as any[]
    expect(heading).toEqual({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Authentication" }] })
    // A section's own key (if any) is deliberately not indexed — only its children carry macros.
    expect(macroKeyOf(requirement.content[0])).toBe("F-01")
  })

  it("nests heading levels with the tree depth", () => {
    const doc = buildRequirementsAdf(
      tree([section("Top", [section("Sub", [leaf("F-01", "A")])])])
    )
    expect((doc.content as any[]).filter((n) => n.type === "heading").map((h) => h.attrs.level)).toEqual([2, 3])
  })

  it("caps heading levels at 6 — ADF has no h7", () => {
    let deepest: RequirementNode = section("L9", [leaf("F-01", "A")])
    for (let i = 8; i >= 1; i--) deepest = section(`L${i}`, [deepest])
    const levels = (buildRequirementsAdf(tree([deepest])).content as any[])
      .filter((n) => n.type === "heading")
      .map((h) => h.attrs.level)
    expect(Math.max(...levels)).toBe(6)
  })

  it("applies the table/paragraph heuristic to the leaves of each section", () => {
    const doc = buildRequirementsAdf(
      tree([
        section("Auth", [
          leaf("F-01", "Login", [{ label: "Priority", value: "High" }]),
          leaf("F-02", "Logout", [{ label: "Priority", value: "Low" }]),
          leaf("F-03", "Free-form"),
        ]),
      ])
    )
    expect((doc.content as any[]).map((n) => n.type)).toEqual(["heading", "table", "paragraph"])
  })
})
