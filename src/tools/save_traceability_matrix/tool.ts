import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { MatrixStatusSchema, SharedLevelSchema } from "../../shared/traceability/dto.js"
import { structuralProblems } from "../../shared/traceability/matrixColumns.js"
import { MatrixSaveReportSchema, formatSaveReport, saveTraceabilityMatrix } from "../../shared/traceability/matrix.js"
import { ColumnInputSchema, MATRIX_INPUT, matrixErrorGuidance, toColumnRequests } from "../../shared/traceability/toolInputs.js"
import { registerTool, toolError, TOOL_NAMES } from "../../core/mcp/registry.js"

// Use case 4, step 2: re-validates every column against the live suggestions, then persists — or
// refuses without writing anything if one column does not hold up. Requirement Yogi itself only
// checks that a matrix has at least one column, so this is the only thing standing between the
// user and a matrix that saves cleanly and renders empty.
export function registerSaveTraceabilityMatrixTool(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.saveTraceabilityMatrix,
    {
      // Writes a saved query, and re-running it creates another one (hence not idempotent). It only
      // ever adds a saved matrix — or replaces the one whose matrix_id was given — so nothing else
      // is at risk, but a client should still confirm it with the user.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      errorGuidance: matrixErrorGuidance,
      outputSchema: MatrixSaveReportSchema.shape,
      inputSchema: {
        ...MATRIX_INPUT,
        name: z.string().min(1).max(255).describe("Name of the saved query (required, max 255 characters)"),
        description: z.string().optional().describe("Optional description of what the matrix shows"),
        columns: z
          .array(ColumnInputSchema)
          .min(1)
          .describe(
            "The columns to add beside the requirements column, in definition order — every one of them taken from discover_matrix_columns"
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How many requirements the matrix renders (default 200)"),
        shared_level: SharedLevelSchema
          .optional()
          .describe(
            "NONE (private), SHARED_VIEW or SHARED_EDIT. Defaults to NONE on a create, and to the matrix's current level on an update"
          ),
        status: MatrixStatusSchema
          .optional()
          .describe(
            "ACTIVE — the matrix is live. ARCHIVED retires it without losing it, DELETED soft-deletes it. Only pass one of those two if the user explicitly asked for it. Defaults to ACTIVE on a create, and to the matrix's current status on an update"
          ),
        matrix_id: z
          .number()
          .int()
          .optional()
          .describe(
            "ID of an existing saved matrix to REPLACE; omit to create a new one. Anything you leave out (description, shared_level, status, limit, variants) keeps the value the stored matrix already has"
          ),
      },
    },
    async ({ space, query, name, description, columns, variants, limit, shared_level, status, matrix_id, variable_values, base_url }) => {
      const requests = toColumnRequests(columns)
      const problems = structuralProblems(requests)
      if (problems.length) {
        return toolError(`Nothing was saved — the columns do not form a valid column tree:\n${problems.join("\n")}`)
      }

      const report = await saveTraceabilityMatrix({
        spaceKey: space,
        query,
        name,
        description,
        columns: requests,
        variants,
        limit,
        sharedLevel: shared_level,
        status,
        matrixId: matrix_id,
        variableValues: variable_values,
        instanceBaseUrl: base_url,
      })

      return {
        structuredContent: report,
        content: [{ type: "text", text: formatSaveReport(report) }],
        // A refused matrix IS an error: nothing was written, and the model must fix the columns.
        ...(report.saved ? {} : { isError: true }),
      }
    }
  )
}
