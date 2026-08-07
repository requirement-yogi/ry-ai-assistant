import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ryClient } from "../../core/ryClient.js"
import { OrganizationSchema } from "../../core/dto.js"
import { registerTool, TOOL_NAMES, READS_REMOTE_STATE } from "../../core/mcp/registry.js"

// Use case 3, step 0 (only when the token spans several organizations): discover the Requirement
// Yogi organizations the access token can see.
export function registerListOrganizationsTool(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.listOrganizations,
    {
      annotations: READS_REMOTE_STATE,
      inputSchema: {},
      outputSchema: { organizations: z.array(OrganizationSchema) },
    },
    async () => {
      const organizations = await ryClient().listOrganizations()
      return {
        structuredContent: { organizations },
        content: [
          {
            type: "text",
            text: `Accessible organizations (JSON from the Requirement Yogi API):
${JSON.stringify(organizations)}

If there are several, ask the user which one to use (the organization ID is visible in the Requirement Yogi admin panel in Confluence or Jira), then pass it as organization_id to list_applications.`,
          },
        ],
      }
    }
  )
}
