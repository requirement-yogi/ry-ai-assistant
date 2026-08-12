import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ryClient } from "../../core/api/ryClient.js"
import { ApplicationSchema } from "../../core/dto.js"
import { registerTool, TOOL_NAMES, READS_REMOTE_STATE } from "../../core/toolRegistration/registerTool.js"

// Use case 3, step 1: discover the Confluence and Jira instances connected to Requirement Yogi.
export function registerListApplicationsTool(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.listApplications,
    {
      annotations: READS_REMOTE_STATE,
      outputSchema: { applications: z.array(ApplicationSchema) },
      inputSchema: {
        organization_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Organization ID (from list_organizations); only needed when the token can see several organizations — ask the user which one to use"
          ),
      },
    },
    async ({ organization_id }) => {
      const applications = await ryClient().listApplications(organization_id)
      return {
        structuredContent: { applications },
        content: [
          {
            type: "text",
            text: `Connected applications (JSON from the Requirement Yogi API):
${JSON.stringify(applications)}

Keep the application IDs (jira_application_id) and base URLs (base_url) for the next steps.`,
          },
        ],
      }
    }
  )
}
