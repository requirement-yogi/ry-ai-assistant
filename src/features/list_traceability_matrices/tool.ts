import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { MATRIX_TYPE } from "../../shared/traceability/dto.js"
import { SavedMatrixListSchema, listSavedMatrices } from "../../shared/traceability/matrix.js"
import { MATRIX_INPUT } from "../../shared/traceability/toolInputs.js"
import { registerTool, TOOL_NAMES, READS_REMOTE_STATE } from "../../core/toolRegistration/registerTool.js"

// Use case 4, read back: find the saved matrices that already exist (to get a matrix_id, or to
// check a name is not already taken before saving a new one).
export function registerListTraceabilityMatricesTool(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.listTraceabilityMatrices,
    {
      annotations: READS_REMOTE_STATE,
      outputSchema: SavedMatrixListSchema.shape,
      inputSchema: {
        space: z.string().optional().describe("Restrict to one Confluence space"),
        name: z.string().optional().describe("Filter by name"),
        owned: z
          .boolean()
          .optional()
          .describe("true (default) lists the user's own saved matrices; false includes the shared ones"),
        traceability_only: z
          .boolean()
          .optional()
          .describe("true (default) lists only TRACEABILITY matrices; false includes MODIFICATION and COVERAGE"),
        offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
        limit: z.number().int().positive().optional().describe("Page size (default 50)"),
        base_url: MATRIX_INPUT.base_url,
      },
    },
    async ({ space, name, owned, traceability_only, offset, limit, base_url }) => {
      const list = await listSavedMatrices({
        filters: {
          // `owned` is the one filter the backend requires.
          owned: owned ?? true,
          ...(space ? { spaceKey: space } : {}),
          ...(name ? { name } : {}),
          ...(traceability_only === false ? {} : { matrixType: MATRIX_TYPE.traceability }),
        },
        offset,
        limit,
        instanceBaseUrl: base_url,
      })
      return {
        structuredContent: list,
        content: [
          {
            type: "text",
            text: `Saved matrices (JSON from the Requirement Yogi API):
${JSON.stringify(list)}

Only the summary is listed. Call get_traceability_matrix with an id to see a matrix's query and columns.`,
          },
        ],
      }
    }
  )
}
