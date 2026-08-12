// The MCP input surface shared by the tools that describe a matrix column tree — genuinely shared
// (not just similar): discover_matrix_columns and save_traceability_matrix accept the exact same
// column shape and the same space/query/variants inputs, and get/list reuse base_url. Kept here,
// next to the domain logic in matrix.ts/matrixColumns.ts, rather than duplicated per tool folder.

import { z } from "zod"
import { RyApiError } from "../../core/errors.js"
import { StepTypeSchema } from "./dto.js"
import type { ColumnRequest } from "./matrixColumns.js"

// A column as the LLM asks for it. snake_case at the frontier, translated to the service's
// ColumnRequest by toColumnRequests below.
//
// FIRST_COLUMN is excluded from the enum on purpose: column 0 is a structural invariant this MCP
// injects, so offering it as a choice would only invite an invalid definition.
export const ColumnInputSchema = z.object({
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

export function toColumnRequests(columns: ColumnInput[]): ColumnRequest[] {
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
export const matrixErrorGuidance = (error: unknown): string | undefined =>
  error instanceof RyApiError && error.status >= 500 && error.path.startsWith("/rest/traceability")
    ? "IGNORE the generic advice above about retrying: a 500 from the matrix generation endpoint is an unhandled server-side error, so the same call will fail the same way. Retry AT MOST once, then stop and tell the user the matrix could not be generated for this space and query, quoting the error. Do not try to work around it by changing the columns — the failure happens before the columns are even looked at."
    : undefined

// Inputs shared by the two tools that describe a matrix (discover + save); base_url is also reused
// by get and list.
export const MATRIX_INPUT = {
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
