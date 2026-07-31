import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ryClient } from "../api/ryClient.js"
import { MATRIX_TYPE, MatrixStatusSchema, SharedLevelSchema, StepTypeSchema } from "../api/traceabilityDto.js"
import { structuralProblems, type ColumnRequest } from "../services/matrixColumns.js"
import {
  discoverMatrixColumns,
  formatSaveReport,
  listSavedMatrices,
  readSavedMatrix,
  MatrixSaveReportSchema,
  SavedMatrixListSchema,
  SavedMatrixReadingSchema,
  saveTraceabilityMatrix,
} from "../services/traceabilityMatrix.js"
import { registerTool, toolError, TOOL_NAMES, READS_REMOTE_STATE } from "./registry.js"
import { RyApiError } from "../errors.js"

// Use case 4: traceability matrices — persisted { RQL query + column tree } saved queries.
//
// The workflow is orchestrated by the client LLM, and it is a LOOP, not a single call:
//   1. discover_matrix_columns  → what can be attached to the columns picked so far (one call per
//                                 level of depth: level N+1 is unknowable before level N exists)
//   2. save_traceability_matrix → re-validates every column against the live suggestions, then
//                                 persists (or refuses, without writing anything)
//   3. get_traceability_matrix / list_traceability_matrices → read back
//
// Everything the LLM reads lives in src/prompts/tools/<tool name>.md, with the loop written once in
// src/prompts/fragments/traceability-workflow.md.

// A column as the LLM asks for it. snake_case at the frontier, translated to the service's
// ColumnRequest by toColumnRequests below.
//
// FIRST_COLUMN is excluded from the enum on purpose: column 0 is a structural invariant this MCP
// injects, so offering it as a choice would only invite an invalid definition.
const ColumnInputSchema = z.object({
  type: StepTypeSchema.exclude(["FIRST_COLUMN"]).describe(
    "The column's step type, exactly as returned by discover_matrix_columns (never invented)"
  ),
  // Accepts null as well as an absent value: discover_matrix_columns reports a valueless column as
  // "" and a model may well hand back a null instead — that is not worth a validation failure.
  value: z
    .string()
    .nullish()
    .describe(
      "The step's value, from discover_matrix_columns: relationship name (TO/FROM), property key (PROPERTY/EXTERNAL_PROPERTY), Jira field key (JIRAFIELD), Zephyr object type (ZEPHYR_SCALE), formula (CALCULATION). Omit for the types that carry none (DESCRIPTION, VARIANT, SPACE_KEY, LINKS, ALL_*)"
    ),
  label: z
    .string()
    .optional()
    .describe("Column header. Defaults to the step's value, or a readable default for the type"),
  parent_column_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Index of the column this one hangs under (columns form a TREE). 0 is the requirements column and is the default; must be lower than this column's own index"
    ),
  hidden: z.boolean().optional().describe("Keep the column in the definition but do not display it (default false)"),
  accumulator: z
    .object({
      display: z.boolean(),
      formula: z.string(),
      data_type: z.string(),
    })
    .optional()
    .describe("Accumulator for an aggregating column (rarely needed)"),
})

type ColumnInput = z.infer<typeof ColumnInputSchema>

function toColumnRequests(columns: ColumnInput[]): ColumnRequest[] {
  return columns.map((column) => ({
    type: column.type,
    value: column.value,
    label: column.label,
    parentColumnIndex: column.parent_column_index,
    hidden: column.hidden,
    accumulator: column.accumulator
      ? { display: column.accumulator.display, formula: column.accumulator.formula, dataType: column.accumulator.data_type }
      : undefined,
  }))
}

// The matrix generation endpoint answers a payload it cannot handle with a bare 500 ("An unexpected
// error has occurred", empty `errors`) — an unhandled server exception, not a validation message. The
// generic 5xx guidance ("usually transient — retry shortly") is actively wrong there: retrying an
// identical payload cannot help, and a retry loop against a 500 is worse than stopping.
const matrixErrorGuidance = (error: unknown): string | undefined =>
  error instanceof RyApiError && error.status >= 500 && error.path.startsWith("/rest/traceability")
    ? "IGNORE the generic advice above about retrying: a 500 from the matrix generation endpoint is an unhandled server-side error, so the same call will fail the same way. Retry AT MOST once, then stop and tell the user the matrix could not be generated for this space and query, quoting the error. Do not try to work around it by changing the columns — the failure happens before the columns are even looked at."
    : undefined

// Inputs shared by the two tools that describe a matrix (discover + save).
const MATRIX_INPUT = {
  space: z.string().min(1).describe("Confluence space key the matrix belongs to"),
  query: z
    .string()
    .min(1)
    .describe(
      "The RQL query selecting the ROOT requirements — the ones column 0 will hold. A structured \"field operator value\" expression, e.g. \"key ~ 'FN-%'\""
    ),
  variants: z
    .array(z.number().int())
    .optional()
    .describe(
      "Variant IDs the matrix is filtered on. Omit for the current variant. If the space uses variants, pass them explicitly — search_requirements reports each requirement's variantId"
    ),
  variable_values: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Values for the variables the query uses, if it uses any"),
  base_url: z
    .string()
    .optional()
    .describe(
      "Base URL of the Confluence instance (from list_applications); only needed when several Confluence instances are connected"
    ),
} as const

export function registerTraceabilityTools(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.discoverMatrixColumns,
    {
      annotations: READS_REMOTE_STATE,
      errorGuidance: matrixErrorGuidance,
      // No outputSchema: the candidate vocabulary of a rich space (every property, every
      // relationship, every Jira field, per column) is unbounded by the data, and the spec would
      // have us serialise it into a text block as well — sending it twice for no gain. Same call as
      // search_requirements.
      inputSchema: {
        ...MATRIX_INPUT,
        columns: z
          .array(ColumnInputSchema)
          .optional()
          .describe(
            "The columns already picked, in definition order (column 0 is implicit). Leave empty on the first call; pass what you kept to discover what can be attached UNDER them"
          ),
      },
    },
    async ({ space, query, columns, variants, variable_values, base_url }) => {
      const chosen = toColumnRequests(columns ?? [])
      // Structural nonsense (a parent that doesn't exist yet) is caught without paying for a matrix
      // generation, and reads better than whatever the API would answer.
      const problems = structuralProblems(chosen)
      if (problems.length) {
        return toolError(`The columns you passed do not form a valid column tree:\n${problems.join("\n")}`)
      }

      // `chosen` is what makes this a LOOP: the probe must carry the columns already picked, or the
      // response describes column 0 again and the caller can never see one level deeper.
      const discovery = await discoverMatrixColumns(
        {
          spaceKey: space,
          query,
          variants,
          variableValues: variable_values,
          instanceBaseUrl: base_url,
        },
        chosen
      )

      return {
        content: [
          {
            type: "text",
            text: `Columns available for this matrix (derived from the requirements the query actually returns):
${JSON.stringify(discovery)}

Each entry of "columns" is one column of the matrix as it stands; its "candidates" are what you can attach UNDER it, ready to be passed back in \`columns\` (keep type, value and parent_column_index as they are).
"legend" says what each column type MEANS — use it to match the user's request to a type instead of guessing from the enum name (e.g. the page a requirement is written on is ORIGINAL_LINKS).
To go one level deeper, add the candidate you want to \`columns\` and call this tool again — the suggestions for a new column cannot exist before the column does.
Read the "notes": a false all* flag means such a column is ALREADY attached there, NOT that the data does not support it.
There is no global list of available columns: this vocabulary is specific to this query's requirements.`,
          },
        ],
      }
    }
  )

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
