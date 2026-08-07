import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ryClient } from "../../core/ryClient.js"
import { RelationshipSchema } from "../../core/dto.js"
import { registerTool, TOOL_NAMES, READS_REMOTE_STATE } from "../../core/mcp/registry.js"

// Use case 3, step before linking: the relationship types available to qualify a link (e.g.
// "implements", "is tested by").
export function registerListRelationshipsTool(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.listRelationships,
    {
      annotations: READS_REMOTE_STATE,
      outputSchema: { relationships: z.array(RelationshipSchema) },
      inputSchema: {
        application_id: z
          .number()
          .int()
          .optional()
          .describe(
            "RY application identifier; required unless the access token is already scoped to a single application"
          ),
      },
    },
    async ({ application_id }) => {
      const relationships = await ryClient().listAllRelationships(application_id)
      return {
        structuredContent: { relationships },
        content: [
          {
            type: "text",
            text: `Available relationships (JSON from the Requirement Yogi API):
${JSON.stringify(relationships)}

Keep the relationship IDs: they are needed by link_requirements_to_jira.`,
          },
        ],
      }
    }
  )
}
