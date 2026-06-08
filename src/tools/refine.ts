import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { RequirementsTreeSchema } from "../schemas/requirements.js"

export function registerRefineTool(server: McpServer) {
  server.registerTool(
    "refine_requirements",
    {
      description: `Refines an existing requirements tree by applying user feedback.

Two types of changes are possible:

1. REQUIREMENT CONTENT (text, properties, keys, structure) → modify the JSON then call render_requirements.
2. DOCUMENT ENRICHMENT (adding free text, notes, context around requirements) → can be done directly on the Markdown after rendering, without touching the JSON.`,
      inputSchema: {
        current_tree: z.record(z.string(), z.unknown()).describe("The current requirements tree (complete JSON object)"),
        feedback: z.string().describe("The feedback or changes requested by the user"),
      },
    },
    async ({ current_tree, feedback }) => {
      const validation = RequirementsTreeSchema.safeParse(current_tree)
      if (!validation.success) {
        return {
          content: [{ type: "text", text: `Error: the provided tree is invalid. ${validation.error.message}` }],
          isError: true,
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Apply the feedback to the requirements tree, then call render_requirements with the updated result.

FEEDBACK: ${feedback}

CURRENT TREE:
${JSON.stringify(current_tree, null, 2)}

STEPS:
1. If the feedback is about requirement content (text, properties, structure, keys):
   → Modify the JSON and call render_requirements(tree) to regenerate the Markdown.
2. If the feedback is only about document enrichment (adding an example, a note, context):
   → Add the Markdown content directly around the existing requirements, without touching the JSON.
3. In all cases: every requirement must keep its \`req:KEY\` tag in a valid context (paragraph, heading, or table cell).`,
          },
        ],
      }
    }
  )
}
