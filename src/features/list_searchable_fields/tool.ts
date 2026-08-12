import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { listSearchableFields, SearchableFieldsSchema } from "./schemaGrounding.js"
import { registerTool, TOOL_NAMES, READS_REMOTE_STATE } from "../../core/toolRegistration/registerTool.js"

// Use case 3, schema grounding: the space's REAL searchable identifiers, so the LLM never has to
// invent a field/property/relationship/variant name when writing an RQL query.
export function registerListSearchableFieldsTool(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.listSearchableFields,
    {
      annotations: READS_REMOTE_STATE,
      outputSchema: SearchableFieldsSchema.shape,
      inputSchema: {
        space: z.string().min(1).describe("The Confluence space key whose searchable fields you want"),
        application_id: z
          .number()
          .int()
          .optional()
          .describe(
            "RY application identifier for the relationships lookup; required unless the token is already scoped to one application"
          ),
        base_url: z
          .string()
          .optional()
          .describe(
            "Base URL of the Confluence instance (from list_applications); only needed when several Confluence instances are connected"
          ),
      },
    },
    async ({ space, application_id, base_url }) => {
      const fields = await listSearchableFields({ spaceKey: space, applicationId: application_id, instanceBaseUrl: base_url })
      return {
        structuredContent: fields,
        content: [
          {
            type: "text",
            text: `Searchable fields for space "${space}" (JSON from the Requirement Yogi API):
${JSON.stringify(fields)}

Use ONLY these identifiers when writing the query for search_requirements (plus the core fields key/text/page/status/jira). Prefix them per the syntax: @property, ext@property, from@/to@/jira@relationship.`,
          },
        ],
      }
    }
  )
}
