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

  // Tableau vertical sans header (trick MD → ADF vertical table)
  md += `| | |\n`
  md += `| :--- | :--- |\n`
  md += `| **Clé** | ${node.key} |\n`
  for (const prop of node.properties) {
    md += `| **${prop.label}** | ${escapeCell(prop.value)} |\n`
  }
  md += "\n"

  if (node.children.length === 0) return md

  const leaves = node.children.filter((c) => c.children.length === 0)
  const branches = node.children.filter((c) => c.children.length > 0)

  // Tableau horizontal pour les enfants feuilles (sans titre de section)
  if (leaves.length > 0) {
    const labels = collectLabels(leaves)

    md += `| Clé | Titre | ${labels.join(" | ")} |\n`
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

  // Récursion pour les enfants avec leurs propres enfants
  for (const branch of branches) {
    md += renderNode(branch, level + 1)
  }

  return md
}

export function renderTree(tree: RequirementsTree): string {
  const date = new Date(tree.created_at).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  })

  let md = `# ${tree.project_name}\n\n`
  md += `*${tree.description}*\n\n`
  md += `> Généré le ${date}\n\n`
  md += `---\n\n`

  for (const req of tree.requirements) {
    md += renderNode(req, 2)
  }

  return md
}

export const RENDER_TOOL = {
  name: "render_requirements",
  description: `Convertit un arbre de requirements JSON en document Markdown structuré avec des tableaux.

Utilise ce tool après analyze_prompt ou refine_requirements pour afficher un aperçu lisible des requirements.
Le Markdown produit sera aussi ce qui est envoyé au backend via submit_requirements.`,
} as const

export function validateAndRender(raw: unknown): string {
  const tree = RequirementsTreeSchema.parse(raw)
  return renderTree(tree)
}
