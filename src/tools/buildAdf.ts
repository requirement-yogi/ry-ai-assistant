import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { RequirementsTreeSchema } from "../schemas/requirements.js"
import { buildRequirementsAdf } from "./adfRender.js"
import { KEY_RULES, INDEXING_CONTEXTS } from "./indexingRules.js"

export function registerBuildAdfTool(server: McpServer) {
  server.registerTool(
    "build_requirements_adf",
    {
      description: `USE THIS TOOL when the user wants to create a NEW Confluence page from a set of requirements.

This MCP owns the Requirement Yogi indexing rules. You provide a structured requirements tree;
it deterministically produces an Atlassian Document Format (ADF) body with the Requirement Yogi
macros placed in valid indexing contexts. You do NOT write ADF or Markdown yourself.

How the tree is rendered (decided by this tool, not by you):
- A node WITH children → a section heading (no macro), then its children below.
- A leaf WITH properties → a table row (key macro | description | one column per property).
  Consecutive leaf siblings that share the same property labels are merged into one table.
- A leaf WITHOUT properties → a paragraph (key macro followed by the description).

Your job is the decomposition: break the user's request into a hierarchy of requirements, each with
a free-form key, a description, and optional properties (label/value). Leave a node's key empty when
it is only a section grouping its children.

${KEY_RULES}

${INDEXING_CONTEXTS}

After this tool returns, publish the ADF with another available tool (e.g. Atlassian MCP
createConfluencePage) using contentFormat "adf".`,
      inputSchema: {
        tree: z
          .record(z.string(), z.unknown())
          .describe("The requirements tree (complete JSON object matching the requirements schema)"),
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
