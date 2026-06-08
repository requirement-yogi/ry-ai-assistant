import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { RequirementsTreeSchema } from "../schemas/requirements.js"

const FORMAT_RULES = `
REQUIREMENT INDEXING RULES — MANDATORY:

Every requirement must appear in the Markdown with a \`req:KEY\` tag (e.g. \`req:AUTH-001\`).
The backtick notation is both the visual marker and what the backend parser looks for.

Three valid contexts for a \`req:KEY\` tag:

1. Paragraph — requirement with a full textual description:
   \`req:KEY\` The system shall... Priority: HIGH. Status: Draft.

2. Heading — requirement that titles a section detailed below:
   ## \`req:KEY\` — Section Title

3. Table cell — requirements that share a common structure:
   | Key | Description | Priority |
   |---|---|---|
   | \`req:KEY\` | Description | HIGH |

STRICT RULES:
- Each KEY appears exactly once — never repeat the same \`req:KEY\` in multiple places.
- Only the three contexts above are parsed; tags inside blockquotes, code blocks, or list items are ignored.
- Do NOT place a requirement outside one of these three contexts.

FREEDOM:
Outside these constraints, the document structure is entirely your choice.
Use headings, sections, tables, prose — whatever layout best communicates this specific requirement tree.`

export function registerRenderTool(server: McpServer) {
  server.registerTool(
    "render_requirements",
    {
      description: `Validates the requirements tree and instructs the LLM to generate the Markdown document.

The LLM chooses the layout that best represents the specific tree (headings, tables, prose, etc.).
Every requirement must include a \`req:KEY\` tag so the backend can parse and index it.

Call after analyze_prompt or refine_requirements.`,
      inputSchema: {
        tree: z.record(z.string(), z.unknown()).describe("The requirements tree (complete JSON object)"),
      },
    },
    async ({ tree }) => {
      const validation = RequirementsTreeSchema.safeParse(tree)
      if (!validation.success) {
        return {
          content: [{ type: "text", text: `Validation error: ${validation.error.message}` }],
          isError: true,
        }
      }

      const { project_name, description, created_at, requirements } = validation.data
      const date = new Date(created_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })

      return {
        content: [
          {
            type: "text",
            text: `Generate a Markdown requirements document for the tree below.
You have full freedom over the document layout — choose the structure that best communicates this specific tree.
Follow the indexing rules exactly so the backend can parse and index each requirement.

PROJECT: ${project_name}
DESCRIPTION: ${description}
DATE: ${date}

JSON TREE:
${JSON.stringify(requirements, null, 2)}

${FORMAT_RULES}

Display the generated Markdown directly in your response (render it, do not wrap in a code block).
Then ask the user if they want to refine (via refine_requirements) or submit (via submit_requirements).`,
          },
        ],
      }
    }
  )
}
