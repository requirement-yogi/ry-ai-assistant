import type { RequirementNode, RequirementsTree, Property } from "../schemas/requirements.js"
import { buildInlineExtension } from "./macro.js"

// --- Minimal ADF node shapes ---

export type InlineNode = { type: string; text?: string; attrs?: Record<string, unknown> }
export type Paragraph = { type: "paragraph"; content: InlineNode[] }
export type Heading = { type: "heading"; attrs: { level: number }; content: InlineNode[] }
export type TableCell = {
  type: "tableCell" | "tableHeader"
  attrs: Record<string, unknown>
  content: Paragraph[]
}
export type TableRow = { type: "tableRow"; content: TableCell[] }
export type Table = {
  type: "table"
  attrs: { isNumberColumnEnabled: false; layout: "default" }
  content: TableRow[]
}
export type BlockNode = Paragraph | Heading | Table
export type AdfDoc = { version: 1; type: "doc"; content: BlockNode[] }

// Structural subset shared by the from-scratch builder and the page editor.
export type RequirementRow = { key?: string; description: string; properties: Property[] }

const MAX_HEADING_LEVEL = 6

// --- Inline helpers ---

function text(value: string): InlineNode {
  return { type: "text", text: value }
}

function macro(key: string): InlineNode {
  return buildInlineExtension(key) as InlineNode
}

function cell(type: "tableCell" | "tableHeader", content: InlineNode[]): TableCell {
  return { type, attrs: {}, content: [{ type: "paragraph", content }] }
}

// --- Node classification ---

function isSection(node: RequirementNode): boolean {
  return node.children.length > 0
}

// Group leaf requirements that share the exact same ordered set of property labels —
// they form one Requirement Yogi table together (RY's "shared structure" intent).
function propertySignature(node: RequirementRow): string {
  return node.properties.map((p) => p.label).join(" ")
}

// --- Context builders (the Requirement Yogi indexing intelligence) ---

// PARAGRAPH context: macro followed by the description. For requirements with no properties.
export function renderRequirementParagraph(node: { key?: string; description: string }): Paragraph {
  const content: InlineNode[] = []
  if (node.key) {
    content.push(macro(node.key))
    if (node.description) content.push(text(` ${node.description}`))
  } else if (node.description) {
    content.push(text(node.description))
  }
  return { type: "paragraph", content }
}

// HEADING context (structure only): section title, no macro.
function renderHeading(node: RequirementNode, level: number): Heading {
  return {
    type: "heading",
    attrs: { level: Math.min(level, MAX_HEADING_LEVEL) },
    content: [text(node.description)],
  }
}

// TABLE context: col1 = key macro, col2 = description, col3+ = properties.
// All rows share the property labels of the first row.
export function renderRequirementsTable(group: RequirementRow[]): Table {
  const labels = group[0].properties.map((p) => p.label)

  const headerRow: TableRow = {
    type: "tableRow",
    content: [
      cell("tableHeader", [text("Key")]),
      cell("tableHeader", [text("Description")]),
      ...labels.map((label) => cell("tableHeader", [text(label)])),
    ],
  }

  const dataRows: TableRow[] = group.map((node) => ({
    type: "tableRow",
    content: [
      cell("tableCell", node.key ? [macro(node.key)] : []),
      cell("tableCell", [text(node.description)]),
      ...node.properties.map((p) => cell("tableCell", [text(p.value)])),
    ],
  }))

  return {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: [headerRow, ...dataRows],
  }
}

// Render a flat run of requirements into blocks: consecutive rows sharing the same
// property signature become one table; a row with no properties becomes a paragraph.
export function renderRequirementRows(rows: RequirementRow[]): BlockNode[] {
  const blocks: BlockNode[] = []
  let i = 0

  while (i < rows.length) {
    if (rows[i].properties.length > 0) {
      const sig = propertySignature(rows[i])
      const group: RequirementRow[] = []
      while (i < rows.length && rows[i].properties.length > 0 && propertySignature(rows[i]) === sig) {
        group.push(rows[i])
        i++
      }
      blocks.push(renderRequirementsTable(group))
      continue
    }

    blocks.push(renderRequirementParagraph(rows[i]))
    i++
  }

  return blocks
}

// --- Recursive tree → blocks (from-scratch page) ---

function renderNodes(nodes: RequirementNode[], level: number): BlockNode[] {
  const blocks: BlockNode[] = []
  let i = 0

  while (i < nodes.length) {
    if (isSection(nodes[i])) {
      blocks.push(renderHeading(nodes[i], level))
      blocks.push(...renderNodes(nodes[i].children, level + 1))
      i++
      continue
    }

    // Gather a run of consecutive leaves and render them (tables + paragraphs).
    const run: RequirementNode[] = []
    while (i < nodes.length && !isSection(nodes[i])) {
      run.push(nodes[i])
      i++
    }
    blocks.push(...renderRequirementRows(run))
  }

  return blocks
}

export function buildRequirementsAdf(tree: RequirementsTree): AdfDoc {
  const content: BlockNode[] = []
  if (tree.description) {
    content.push({ type: "paragraph", content: [text(tree.description)] })
  }
  content.push(...renderNodes(tree.requirements, 2))
  return { version: 1, type: "doc", content }
}
