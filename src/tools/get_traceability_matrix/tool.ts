import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ryClient } from "../../core/ryClient.js"
import { SavedMatrixReadingSchema, readSavedMatrix } from "../../shared/traceability/matrix.js"
import { MATRIX_INPUT } from "../../shared/traceability/toolInputs.js"
import { registerTool, TOOL_NAMES, READS_REMOTE_STATE } from "../../core/mcp/registry.js"

// Use case 4, read back: a saved matrix's name, query and full column tree, parsed out of the
// `json` string it is stored in.
export function registerGetTraceabilityMatrixTool(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.getTraceabilityMatrix,
    {
      annotations: READS_REMOTE_STATE,
      outputSchema: SavedMatrixReadingSchema.shape,
      inputSchema: {
        matrix_id: z.number().int().describe("ID of the saved matrix (from list_traceability_matrices)"),
        base_url: MATRIX_INPUT.base_url,
      },
    },
    async ({ matrix_id, base_url }) => {
      const reading = readSavedMatrix(await ryClient().getSavedMatrix(matrix_id, base_url))
      return {
        structuredContent: reading,
        content: [
          {
            type: "text",
            text: `Saved matrix ${matrix_id} (its definition was parsed out of the \`json\` string it is stored in):
${JSON.stringify(reading)}`,
          },
        ],
      }
    }
  )
}
