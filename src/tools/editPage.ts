import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { buildInlineExtension } from "./macro.js"
import {
  renderRequirementsTable,
  renderRequirementParagraph,
  renderRequirementRows,
} from "./adfRender.js"
import { KEY_RULES, INDEXING_CONTEXTS } from "./indexingRules.js"

type Mark = { type: string; attrs?: Record<string, unknown> }
type AdfNode = {
  type: string
  text?: string
  marks?: Mark[]
  attrs?: Record<string, unknown>
  content?: AdfNode[]
}

// Block-level node types — used to decide where a whole-block splice is allowed.
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "table",
  "bulletList",
  "orderedList",
  "blockquote",
  "panel",
  "codeBlock",
  "expand",
  "rule",
  "mediaSingle",
])

function mkText(text: string, marks?: Mark[]): AdfNode {
  const node: AdfNode = { type: "text", text }
  if (marks?.length) node.marks = marks
  return node
}

// Concatenated text of a node's whole subtree — used to match anchors.
function blockText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? ""
  if (!node.content) return ""
  return node.content.map(blockText).join("")
}

// --- INLINE: replace the first occurrence of `anchor` text with a macro, in place ---

function splitTextOnAnchor(
  text: string,
  anchor: string,
  key: string,
  marks?: Mark[]
): { nodes: AdfNode[]; replaced: boolean } {
  const idx = text.indexOf(anchor)
  if (idx === -1) return { nodes: [mkText(text, marks)], replaced: false }

  const nodes: AdfNode[] = []
  if (idx > 0) nodes.push(mkText(text.slice(0, idx), marks))
  nodes.push(buildInlineExtension(key) as unknown as AdfNode)
  const after = text.slice(idx + anchor.length)
  if (after) nodes.push(mkText(after, marks))
  return { nodes, replaced: true }
}

function anchoredInject(
  node: AdfNode,
  key: string,
  anchor: string,
  consumed: { done: boolean }
): AdfNode {
  if (consumed.done) return node

  if ((node.type === "paragraph" || node.type === "heading") && node.content) {
    if (blockText(node).includes(anchor)) {
      consumed.done = true
      const newContent: AdfNode[] = []
      let anchorReplaced = false

      for (const child of node.content) {
        if (child.type !== "text" || anchorReplaced) {
          newContent.push(child)
          continue
        }
        const { nodes, replaced } = splitTextOnAnchor(child.text ?? "", anchor, key, child.marks)
        newContent.push(...nodes)
        if (replaced) anchorReplaced = true
      }

      return { ...node, content: newContent }
    }
  }

  if (node.content) {
    return {
      ...node,
      content: node.content.map((child) => anchoredInject(child, key, anchor, consumed)),
    }
  }

  return node
}

// --- RESHAPE: remove the block(s) matching any anchor and splice new block(s) in their place ---
// Depth-first: the splice happens at the deepest container that directly holds the matching
// blocks, so wrapping a layout/panel is never replaced wholesale.

function applyReplace(
  node: AdfNode,
  anchors: string[],
  newBlocks: AdfNode[],
  state: { done: boolean }
): AdfNode {
  if (state.done || !Array.isArray(node.content)) return node

  // Recurse first so a deeper container wins over this one.
  const recursed = node.content.map((child) => applyReplace(child, anchors, newBlocks, state))
  if (state.done) return { ...node, content: recursed }

  const matchIdx = new Set<number>()
  recursed.forEach((child, i) => {
    if (BLOCK_TYPES.has(child.type) && anchors.some((a) => blockText(child).includes(a))) {
      matchIdx.add(i)
    }
  })
  if (matchIdx.size === 0) return { ...node, content: recursed }

  const first = Math.min(...matchIdx)
  const out: AdfNode[] = []
  recursed.forEach((child, i) => {
    if (i === first) out.push(...newBlocks)
    if (!matchIdx.has(i)) out.push(child)
  })
  state.done = true
  return { ...node, content: out }
}

// --- INSERT: add new block(s) at a position not tied to replacing existing content ---
// `after_anchor` inserts right after the deepest block containing the anchor; otherwise append
// to the document body.

function applyInsertAfter(
  node: AdfNode,
  anchor: string,
  newBlocks: AdfNode[],
  state: { done: boolean }
): AdfNode {
  if (state.done || !Array.isArray(node.content)) return node

  const recursed = node.content.map((child) => applyInsertAfter(child, anchor, newBlocks, state))
  if (state.done) return { ...node, content: recursed }

  const idx = recursed.findIndex(
    (child) => BLOCK_TYPES.has(child.type) && blockText(child).includes(anchor)
  )
  if (idx === -1) return { ...node, content: recursed }

  const out = [...recursed.slice(0, idx + 1), ...newBlocks, ...recursed.slice(idx + 1)]
  state.done = true
  return { ...node, content: out }
}

// --- Operation schema ---

const PropertyShape = z.object({ label: z.string(), value: z.string() })

const RequirementRowShape = z.object({
  key: z.string().min(1),
  description: z.string(),
  properties: z.array(PropertyShape).default([]),
})

const InlineOp = z.object({
  mode: z.literal("inline"),
  key: z.string().min(1).describe("The requirement key for the macro (reuse the page's key verbatim)."),
  anchor: z
    .string()
    .min(1)
    .describe("Exact text to replace with the macro, in a paragraph/heading already in a good context."),
})

const ParagraphOp = z.object({
  mode: z.literal("paragraph"),
  key: z.string().min(1).describe("The requirement key for the macro."),
  description: z.string().describe("The requirement description (text shown after the macro)."),
  replace_anchors: z
    .array(z.string().min(1))
    .min(1)
    .describe("Exact text of the block(s) to remove and replace with this requirement paragraph."),
})

const TableOp = z.object({
  mode: z.literal("table"),
  requirements: z
    .array(RequirementRowShape)
    .min(1)
    .describe("The requirements that share a structure and become rows of one table."),
  replace_anchors: z
    .array(z.string().min(1))
    .min(1)
    .describe("Exact text of the block(s) to remove and replace with this table (e.g. the prose paragraphs)."),
})

const InsertOp = z.object({
  mode: z.literal("insert"),
  requirements: z
    .array(RequirementRowShape)
    .min(1)
    .describe(
      "New requirements to add. They are rendered with the same heuristic as a new page: rows sharing the same properties become one table, a row with no properties becomes a paragraph."
    ),
  position: z
    .discriminatedUnion("place", [
      z.object({
        place: z.literal("after_anchor"),
        anchor: z
          .string()
          .min(1)
          .describe("Exact text of the existing block to insert right after."),
      }),
      z.object({ place: z.literal("end") }),
    ])
    .describe("Where to add the new content: after an existing block, or at the end of the page."),
})

const OperationSchema = z.discriminatedUnion("mode", [InlineOp, ParagraphOp, TableOp, InsertOp])

// Exported for tests.
export { anchoredInject, applyReplace, applyInsertAfter, blockText }

export function registerEditPageTool(server: McpServer) {
  server.registerTool(
    "edit_page_requirements",
    {
      description: `USE THIS TOOL when the user wants to add or fix Requirement Yogi macros on an EXISTING Confluence page.

This is NOT just "insert a macro where it already fits". First ANALYZE the page (you have its content):
find the functional requirements — including those buried in prose — extract each one's description and
properties, and notice properties that recur across requirements. Then decide how to make the page
indexable and pass a plan of typed operations. This MCP applies them deterministically on the ADF,
preserving every part of the page that is NOT a requirement.

Operate directly on the ADF (no Markdown). For each operation:

- mode "inline": the requirement is already in a paragraph/heading that fits a Requirement Yogi context.
  Just turn the key text into a macro in place. Fields: { key, anchor }.

- mode "paragraph": the requirement is a single textual statement. Replace it with a paragraph that
  carries the macro + description. Fields: { key, description, replace_anchors }.

- mode "table": several requirements share recurring properties. Reshape them into ONE table
  (col 1 = key macro, col 2 = description, col 3+ = properties). Fields: { requirements[], replace_anchors }.

- mode "insert": ADD new requirements that are not described anywhere on the page yet. They are
  rendered like a new page (rows with shared properties → a table, a row without properties → a
  paragraph) and placed at a position. Fields: { requirements[], position }.

Targeting: \`replace_anchors\` are exact text snippets of the existing block(s) to remove; the rendered
result is spliced in at the position of the first one. \`anchor\` (inline) replaces the first matching text.
\`position\` (insert) is either { place: "after_anchor", anchor } or { place: "end" }.

Keys: if the page already labels a requirement with a key, reuse it verbatim (never rename it). If a
requirement has no key yet — e.g. the page only describes the product/features in prose — invent a
free-form key for it. Propose your analysis and plan to the user and get confirmation before publishing.

${KEY_RULES}

${INDEXING_CONTEXTS}

After this tool returns, call updateConfluencePage with the modified ADF and version + 1 to publish.`,
      inputSchema: {
        page_adf: z
          .string()
          .describe(
            "The ADF body as a JSON string — typically body.atlas_doc_format.value from getConfluencePage"
          ),
        operations: z
          .array(OperationSchema)
          .min(1)
          .describe("The ordered edit plan derived from your analysis of the page."),
      },
    },
    async ({ page_adf, operations }) => {
      let adf: AdfNode
      try {
        adf = JSON.parse(page_adf) as AdfNode
      } catch {
        return {
          content: [{ type: "text", text: "Error: page_adf is not valid JSON." }],
          isError: true,
        }
      }

      const applied: string[] = []
      const warnings: string[] = []

      for (const op of operations) {
        if (op.mode === "inline") {
          const consumed = { done: false }
          adf = anchoredInject(adf, op.key, op.anchor, consumed)
          if (consumed.done) applied.push(`inline ${op.key}`)
          else warnings.push(`inline ${op.key}: anchor "${op.anchor}" not found — skipped.`)
          continue
        }

        if (op.mode === "insert") {
          const blocks = renderRequirementRows(op.requirements) as unknown as AdfNode[]
          const keys = op.requirements.map((r) => r.key).join(", ")
          if (op.position.place === "end") {
            adf = { ...adf, content: [...(adf.content ?? []), ...blocks] }
            applied.push(`insert@end (${keys})`)
          } else {
            const state = { done: false }
            adf = applyInsertAfter(adf, op.position.anchor, blocks, state)
            if (state.done) applied.push(`insert@after (${keys})`)
            else
              warnings.push(
                `insert (${keys}): anchor "${op.position.anchor}" not found — skipped.`
              )
          }
          continue
        }

        if (op.mode === "paragraph") {
          const block = renderRequirementParagraph({
            key: op.key,
            description: op.description,
          }) as unknown as AdfNode
          const state = { done: false }
          adf = applyReplace(adf, op.replace_anchors, [block], state)
          if (state.done) applied.push(`paragraph ${op.key}`)
          else
            warnings.push(
              `paragraph ${op.key}: none of the replace_anchors were found — skipped.`
            )
          continue
        }

        // mode "table"
        const block = renderRequirementsTable(op.requirements) as unknown as AdfNode
        const state = { done: false }
        adf = applyReplace(adf, op.replace_anchors, [block], state)
        const keys = op.requirements.map((r) => r.key).join(", ")
        if (state.done) applied.push(`table (${keys})`)
        else warnings.push(`table (${keys}): none of the replace_anchors were found — skipped.`)
      }

      const summary =
        applied.length > 0
          ? `Applied ${applied.length} operation(s): ${applied.join("; ")}.`
          : "No operations were applied."

      const warnText =
        warnings.length > 0 ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : ""

      return {
        content: [
          {
            type: "text",
            text: `${summary}${warnText}

MODIFIED ADF:
${JSON.stringify(adf)}

NEXT STEP: Show the user a summary of the changes, then call updateConfluencePage with:
- pageId: (the original page ID)
- version: (current version number + 1)
- title: (keep the original page title)
- body: <the MODIFIED ADF JSON string above>
- contentFormat: "adf"`,
          },
        ],
      }
    }
  )
}
