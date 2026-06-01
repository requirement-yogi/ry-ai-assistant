import { RequirementsTreeSchema, type RequirementNode, type RequirementsTree } from "../schemas/requirements.js"

function escapeCell(value: string): string {
  return value.replace(/\n/g, " ").replace(/\|/g, "\\|")
}

function collectLabels(nodes: RequirementNode[]): string[] {
  const seen = new Set<string>()
  for (const node of nodes) {
    for (const prop of node.properties) {
      seen.add(prop.label)
    }
  }
  return [...seen]
}

function renderNode(node: RequirementNode, level: number): string {
  const heading = "#".repeat(level)
  let md = `${heading} ${node.title}\n\n`

  // Vertical table with no header row (MD trick → ADF vertical table)
  md += `| | |\n`
  md += `| :--- | :--- |\n`
  md += `| **Key** | ${node.key} |\n`
  md += `| **Title** | ${escapeCell(node.title)} |\n`
  for (const prop of node.properties) {
    md += `| **${prop.label}** | ${escapeCell(prop.value)} |\n`
  }
  md += "\n"

  if (node.children.length === 0) return md

  // Leaf children (no children of their own) → horizontal table
  const leaves = node.children.filter((c) => c.children.length === 0)
  // Branch children (have children) → rendered recursively
  const branches = node.children.filter((c) => c.children.length > 0)

  if (leaves.length > 0) {
    const labels = collectLabels(leaves)

    md += `| Key | Title | ${labels.join(" | ")} |\n`
    md += `| :--- | :--- | ${labels.map(() => ":---").join(" | ")} |\n`

    for (const child of leaves) {
      const values = labels.map((label) => {
        const prop = child.properties.find((p) => p.label === label)
        return prop ? escapeCell(prop.value) : ""
      })
      md += `| ${child.key} | ${escapeCell(child.title)} | ${values.join(" | ")} |\n`
    }
    md += "\n"
  }

  for (const branch of branches) {
    md += renderNode(branch, level + 1)
  }

  return md
}

export function renderTree(tree: RequirementsTree): string {
  const date = new Date(tree.created_at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  })

  let md = `# ${tree.project_name}\n\n`
  md += `*${tree.description}*\n\n`
  md += `> Generated on ${date}\n\n`
  md += `---\n\n`

  for (const req of tree.requirements) {
    md += renderNode(req, 2)
  }

  return md
}

export const RENDER_TOOL = {
  name: "render_requirements",
  description: `Converts a requirements JSON tree into a structured Markdown document with tables.

Use this tool after analyze_prompt or refine_requirements to display a readable preview.
The produced Markdown is also what gets sent to the backend via submit_requirements.`,
} as const

export function validateAndRender(raw: unknown): string {
  const tree = RequirementsTreeSchema.parse(raw)
  return renderTree(tree)
}
