import { buildInlineExtension } from "./submit.js"

// --- ADF types ---

type Mark = { type: "strong" | "em" | "code" }
type TextNode = { type: "text"; text: string; marks?: Mark[] }
type InlineExtNode = ReturnType<typeof buildInlineExtension>
type InlineNode = TextNode | InlineExtNode

type Paragraph = { type: "paragraph"; content: InlineNode[] }
type Heading = { type: "heading"; attrs: { level: number }; content: InlineNode[] }
type Rule = { type: "rule" }
type TableCell = {
  type: "tableCell" | "tableHeader"
  attrs: Record<string, unknown>
  content: [Paragraph]
}
type TableRow = { type: "tableRow"; content: TableCell[] }
type Table = {
  type: "table"
  attrs: { isNumberColumnEnabled: false; layout: "default" }
  content: TableRow[]
}
type ListItem = { type: "listItem"; content: [Paragraph] }
type BulletList = { type: "bulletList"; content: ListItem[] }
type OrderedList = { type: "orderedList"; content: ListItem[] }
type CodeBlock = { type: "codeBlock"; attrs: { language: string }; content: [TextNode] }
type BlockQuote = { type: "blockquote"; content: Paragraph[] }
type BlockNode =
  | Paragraph
  | Heading
  | Rule
  | Table
  | BulletList
  | OrderedList
  | CodeBlock
  | BlockQuote

export type AdfDoc = { version: 1; type: "doc"; content: BlockNode[] }

// --- Inline helpers ---

function mkText(content: string, marks?: Mark[]): TextNode {
  const node: TextNode = { type: "text", text: content }
  if (marks?.length) node.marks = marks
  return node
}

function mkPara(content: InlineNode[]): Paragraph {
  return { type: "paragraph", content }
}

// --- Inline parser ---
// Groups: 1=req:KEY  2=code  3=bold+italic  4=bold(**)  5=italic(*)  6=bold(__)  7=italic(_)
const INLINE_RE =
  /`req:([A-Z]{2,8}-\d{3})`|`([^`\n]+)`|\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*\n]+)\*|__([^_\n]+)__|_([^_\n]+)_/g

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = []
  INLINE_RE.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null

  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(mkText(text.slice(last, m.index)))

    if (m[1]) {
      nodes.push(buildInlineExtension(m[1]))
    } else if (m[2]) {
      nodes.push(mkText(m[2], [{ type: "code" }]))
    } else if (m[3]) {
      nodes.push(mkText(m[3], [{ type: "strong" }, { type: "em" }]))
    } else if (m[4]) {
      nodes.push(mkText(m[4], [{ type: "strong" }]))
    } else if (m[5] !== undefined || m[7] !== undefined) {
      nodes.push(mkText((m[5] ?? m[7])!, [{ type: "em" }]))
    } else if (m[6]) {
      nodes.push(mkText(m[6], [{ type: "strong" }]))
    }

    last = m.index + m[0].length
  }

  if (last < text.length) nodes.push(mkText(text.slice(last)))

  return nodes.filter(
    (n): n is InlineNode => n.type !== "text" || (n as TextNode).text !== ""
  )
}

// --- Table parser ---

function parseTable(tableLines: string[]): Table {
  const rows: TableRow[] = []
  let firstContent = true

  for (const line of tableLines) {
    if (/^\|[\s:|-]+\|$/.test(line.trim())) continue // skip separator rows

    const cells = line.split("|").slice(1, -1).map((c) => c.trim())
    if (cells.every((c) => c === "")) continue

    const cellType = firstContent ? ("tableHeader" as const) : ("tableCell" as const)
    firstContent = false

    rows.push({
      type: "tableRow",
      content: cells.map((cell) => ({
        type: cellType,
        attrs: {},
        content: [mkPara(parseInline(cell))] as [Paragraph],
      })),
    })
  }

  return {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: rows,
  }
}

// --- Block parser ---

// Patterns that start a new block (used to break out of paragraph accumulation)
const BLOCK_STARTER =
  /^(#{1,6} |```|-{3,}|\*{3,}|_{3,}|> |[-*+] |\d+\. )/

export function mdToAdf(markdown: string): AdfDoc {
  const lines = markdown.split("\n")
  const blocks: BlockNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Blank line
    if (line.trim() === "") {
      i++
      continue
    }

    // Heading
    const hMatch = line.match(/^(#{1,6}) (.+)$/)
    if (hMatch) {
      blocks.push({
        type: "heading",
        attrs: { level: hMatch[1].length },
        content: parseInline(hMatch[2]),
      })
      i++
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: "rule" })
      i++
      continue
    }

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      i++
      const codeLines: string[] = []
      while (i < lines.length && !lines[i].startsWith("```")) codeLines.push(lines[i++])
      i++ // skip closing ```
      blocks.push({
        type: "codeBlock",
        attrs: { language: lang },
        content: [{ type: "text", text: codeLines.join("\n") }],
      })
      continue
    }

    // Table
    if (line.trimStart().startsWith("|")) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith("|")) tableLines.push(lines[i++])
      blocks.push(parseTable(tableLines))
      continue
    }

    // Blockquote
    if (line.startsWith(">")) {
      const bqLines: string[] = []
      while (i < lines.length && lines[i].startsWith(">"))
        bqLines.push(lines[i++].replace(/^>\s?/, ""))
      blocks.push({ type: "blockquote", content: [mkPara(parseInline(bqLines.join(" ")))] })
      continue
    }

    // Bullet list
    if (/^[-*+] /.test(line)) {
      const items: ListItem[] = []
      while (i < lines.length && /^[-*+] /.test(lines[i])) {
        items.push({
          type: "listItem",
          content: [mkPara(parseInline(lines[i++].replace(/^[-*+] /, "")))] as [Paragraph],
        })
      }
      blocks.push({ type: "bulletList", content: items })
      continue
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: ListItem[] = []
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push({
          type: "listItem",
          content: [mkPara(parseInline(lines[i++].replace(/^\d+\. /, "")))] as [Paragraph],
        })
      }
      blocks.push({ type: "orderedList", content: items })
      continue
    }

    // Paragraph (accumulate until blank line or next block starter)
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !BLOCK_STARTER.test(lines[i]) &&
      !lines[i].trimStart().startsWith("|")
    ) {
      paraLines.push(lines[i++])
    }

    if (paraLines.length > 0) blocks.push(mkPara(parseInline(paraLines.join(" "))))
  }

  return { version: 1, type: "doc", content: blocks }
}
