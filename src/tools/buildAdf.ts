import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { RequirementsTreeSchema } from "../schemas/requirements.js"
import { buildRequirementsAdf } from "./adfRender.js"
import { registerTool, toolError, TOOL_NAMES, PURE_COMPUTATION } from "./registry.js"

// Use case 1: render a brand-new Confluence page from a requirements tree. The description the LLM
// reads lives in src/prompts/tools/build_requirements_adf.md.

export function registerBuildAdfTool(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.buildRequirementsAdf,
    {
      annotations: PURE_COMPUTATION,
      // No outputSchema: the ADF body is the payload, and the spec would have us serialise it into
      // a text block as well — doubling a document-sized blob for no gain.
      inputSchema: {
        tree: z
          .record(z.string(), z.unknown())
          .describe("The requirements tree (complete JSON object matching the requirements schema)"),
      },
    },
    async ({ tree }) => {
      const validation = RequirementsTreeSchema.safeParse(tree)
      if (!validation.success) {
        return toolError(`Validation error: ${validation.error.message}`)
      }

      const adf = buildRequirementsAdf(validation.data)
      const title = validation.data.project_name

      return {
        content: [
          {
            type: "text",
            text: `Built the ADF body with Requirement Yogi macros.
Page title: "${title}"

ADF (JSON string, ready to pass as \`body\`):
${JSON.stringify(adf)}

NEXT STEP:

Option A — Confluence MCP tools available (e.g. createConfluencePage):
  Call createConfluencePage with:
    - title: "${title}"
    - body: <the ADF JSON string above>
    - contentFormat: "adf"
    - cloudId / spaceId: ask the user if unknown
    - parentId: ask the user if they want to nest the page

Option B — No Confluence tools available:
  Provide the ADF JSON as a downloadable file named "requirements.adf.json".`,
          },
        ],
      }
    }
  )
}
