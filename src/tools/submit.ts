import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { mdToAdf } from "./mdToAdf.js"

const EXTENSION_TYPE = "com.atlassian.ecosystem"
const EXTENSION_KEY =
  "2237ccc1-3339-4360-9e41-d8b594746224/d761c812-7ec0-41d2-a760-254783345820/static/requirement-yogi"
const EXTENSION_ID =
  "ari:cloud:ecosystem::extension/2237ccc1-3339-4360-9e41-d8b594746224/d761c812-7ec0-41d2-a760-254783345820/static/requirement-yogi"

export function buildInlineExtension(reqKey: string) {
  return {
    type: "inlineExtension",
    attrs: {
      extensionType: EXTENSION_TYPE,
      extensionKey: EXTENSION_KEY,
      parameters: {
        guestParams: { reqKey },
        extensionId: EXTENSION_ID,
        render: "native",
        extensionTitle: "Requirement Yogi definition",
      },
    },
  }
}

export function registerSubmitTool(server: McpServer) {
  server.registerTool(
    "submit_requirements",
    {
      description: `Converts the final Markdown document into an Atlassian Document Format (ADF) body with Requirement Yogi inline macros.

The conversion is done server-side: each \`req:KEY\` tag becomes a properly structured inlineExtension macro.
The resulting ADF is then ready to be published using other available tools (e.g. Atlassian MCP createConfluencePage).

Only call this tool once the user has confirmed they are satisfied with the document.`,
      inputSchema: {
        markdown: z.string().describe("The Markdown document produced by render_requirements"),
      },
    },
    async ({ markdown }) => {
      const adf = mdToAdf(markdown)

      const titleMatch = markdown.match(/^#\s+(.+)$/m)
      const title = titleMatch ? titleMatch[1].trim() : "Requirements"

      const adfString = JSON.stringify(adf)

      return {
        content: [
          {
            type: "text",
            text: `The Markdown has been converted to Atlassian Document Format (ADF).
Page title: "${title}"

ADF (JSON string, ready to pass as \`body\`):
${adfString}

NEXT STEP:

Option A — Confluence MCP tools available (e.g. createConfluencePage):
  Call createConfluencePage with:
    - title: "${title}"
    - body: <the ADF JSON string above>
    - contentFormat: "adf"
    - cloudId: ask the user if unknown
    - spaceId: ask the user if unknown
    - parentId: ask the user if they want to nest the page

Option B — No Confluence tools available:
  Provide the ADF JSON as a downloadable file named "requirements.adf.json" for the user.`,
          },
        ],
      }
    }
  )
}
