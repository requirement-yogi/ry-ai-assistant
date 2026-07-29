// Traceability matrices — the orchestration behind the four matrix tools.
//
// Two jobs, both business logic rather than transport, which is why they live here and not in the
// tool file or the client:
//   1. DISCOVERY. There is no "list available columns" endpoint. The only way to learn what a matrix
//      can carry is to POST the matrix and read the `columnSuggestions` that come back alongside the
//      cells, because the backend derives them from the requirements actually present in each
//      column. Suggestions for level N+1 therefore cannot be known before level N exists — the loop
//      is inherently one round trip per level of depth, and it is the caller (the LLM) that walks it
//      by calling discoverMatrixColumns again with the columns it kept.
//   2. VALIDATION BEFORE PERSISTENCE. The backend validates exactly one thing about a matrix
//      definition: that `columns` is non-empty. A column naming a relationship or property that does
//      not exist is saved without complaint and only shows up later as an empty matrix. So every
//      column is re-checked here against live suggestions before anything is written.
//
// The validation walk is incremental ON PURPOSE: column N is checked against the suggestions of the
// matrix that stops BEFORE it. That is the state in which the suggestion flags mean what they say —
// the all* flags are `!alreadyUsed`, so probing with the finished matrix would report the very
// aggregate columns we are validating as unavailable. It costs one round trip per column; a saved
// query is written once and read forever, so correctness wins over latency here.

import { z } from "zod"
import { ryClient, type RyClient } from "../api/ryClient.js"
import { RyResponseError } from "../errors.js"
import { logDev } from "../log.js"
import {
  MATRIX_STATUSES,
  MATRIX_TYPE,
  SHARED_LEVELS,
  StoredMatrixDefinitionSchema,
  type MatrixColumn,
  type MatrixDefinition,
  type SavedMatrix,
  type SavedMatrixFilters,
  type SavedMatrixPayload,
  type MatrixStatus,
  type SharedLevel,
  type StoredMatrixDefinition,
} from "../api/traceabilityDto.js"
import {
  candidatesFor,
  columnLegend,
  draftColumn,
  firstColumn,
  resolveColumn,
  unmappedSuggestionFields,
  type CandidateSet,
  type ColumnCandidate,
  type ColumnRequest,
} from "./matrixColumns.js"

// Only the endpoints this service needs, so tests can drive the discovery and validation loops
// against a fake instead of a live Confluence instance.
export type TraceabilityApi = Pick<
  RyClient,
  "generateTraceabilityMatrix" | "createSavedMatrix" | "updateSavedMatrix" | "getSavedMatrix" | "searchSavedMatrices"
>

// Page size of every PROBE, regardless of the limit the finished matrix will carry.
//
// This is the third trap of the feature: suggestions are derived from the requirements the current
// page returned, so probing with a small limit yields an impoverished vocabulary and silently hides
// columns that are perfectly valid. The default 200 is what the RY UI itself uses.
export const DISCOVERY_LIMIT = 200

// Default `limit` of the SAVED definition (what the matrix will render when someone opens it).
export const DEFAULT_MATRIX_LIMIT = 200

// Each column costs one round trip at validation time; a matrix this wide is a sign the plan went
// wrong, and refusing early beats hammering the API.
export const MAX_COLUMNS = 25

export type MatrixContext = {
  spaceKey: string
  query: string
  variants?: number[] | null
  // Values for the variables the query uses, if any.
  variableValues?: Record<string, unknown>
  instanceBaseUrl?: string
  api?: TraceabilityApi
}

// Assembles the definition the API expects.
//
// No variant is sent as an EMPTY ARRAY, not null. Both mean "the current variant" per the contract,
// but a null collection is the kind of thing a backend iterates without checking — and the matrix
// generation endpoint answers a malformed payload with a bare 500 ("An unexpected error has
// occurred", empty `errors`), i.e. an unhandled exception rather than a validation message. An empty
// list is documented-equivalent and cannot NPE, so there is no reason to send the null.
export function matrixDefinition(context: MatrixContext, columns: MatrixColumn[], limit: number): MatrixDefinition {
  return {
    columns,
    query: context.query,
    variants: context.variants ?? [],
    limit,
    spaceKey: context.spaceKey,
  }
}

// --- Discovery ---------------------------------------------------------------------------------

export type DiscoveredColumn = {
  column_index: number
  label: string
  type: string
  value: string
  // What can be added as a CHILD of this column, ready to be passed back as a column request.
  candidates: ColumnCandidate[]
  notes: string[]
}

export type ColumnDiscovery = {
  space: string
  query: string
  probe_limit: number
  columns: DiscoveredColumn[]
  // What each column type appearing in this response MEANS (see columnLegend). Without it the model
  // has only enum names to reason about, and refuses requests it could actually satisfy.
  legend: Record<string, string>
  notes: string[]
}

// ONE round trip: a matrix carrying column 0 plus whatever the caller already picked, whose response
// describes what can be attached under EVERY one of those columns at once. The caller adds a column
// and calls again to go one level deeper.
//
// The already-picked columns are NOT validated here (that is saveTraceabilityMatrix's job): the
// point of this call is to look under them, and a column that matches nothing simply comes back with
// no candidates — which is itself the answer.
export async function discoverMatrixColumns(
  context: MatrixContext,
  chosen: ColumnRequest[] = []
): Promise<ColumnDiscovery> {
  const { api = ryClient() } = context
  const columns = [firstColumn(), ...chosen.map((request, position) => draftColumn(request, position + 1))]

  const result = await api.generateTraceabilityMatrix({
    // The probe always uses the full page — see DISCOVERY_LIMIT.
    matrix: matrixDefinition(context, columns, DISCOVERY_LIMIT),
    variableValues: context.variableValues,
    instanceBaseUrl: context.instanceBaseUrl,
  })

  const suggestions = result.columnSuggestions ?? []
  const notes: string[] = []
  if (suggestions.length === 0) {
    notes.push(
      "The API returned no column suggestions at all. Check the query really matches requirements in this space — a query that matches nothing has no vocabulary to suggest."
    )
  }

  // A missing entry and a null one mean the same thing: the backend described nothing for that
  // column, so nothing can hang under it. Neither is a reason to fail the whole discovery.
  const translated = columns.map((column) => {
    const suggestion = suggestions[column.columnIndex]
    const set: CandidateSet = suggestion
      ? candidatesFor(suggestion, column.columnIndex)
      : {
          candidates: [],
          notes: ["The API returned no suggestions for this column, so nothing can be attached under it."],
          mentioned: [],
        }
    return { column, set }
  })

  const described: DiscoveredColumn[] = translated.map(({ column, set }) => ({
    column_index: column.columnIndex,
    label: column.label,
    type: column.step.type,
    value: column.step.value,
    candidates: set.candidates,
    notes: set.notes,
  }))

  if (suggestions.length > columns.length) {
    notes.push(
      `The API described ${suggestions.length} columns for a ${columns.length}-column matrix; the extra entries were ignored.`
    )
  }

  // Suggestion fields this build has no mapping for — the safety net under the hard-coded column
  // vocabulary. If Requirement Yogi grows a new column type, it shows up HERE instead of being
  // silently absent from the candidates forever. Aggregated across columns and reported ONCE: a field
  // the endpoint sends on every column would otherwise produce a note per column.
  const unmapped = [
    ...new Set(suggestions.flatMap((suggestion) => (suggestion ? unmappedSuggestionFields(suggestion) : []))),
  ].sort()
  if (unmapped.length) {
    logDev(`matrix suggestions: unmapped field(s) ${unmapped.join(", ")}`)
    notes.push(
      `The API sent suggestion field(s) this version of the MCP does not map: ${unmapped.join(", ")}. If the user is asking for a column that is not in the candidates, this MCP may be behind the Requirement Yogi version of this instance — run check_for_updates and say so rather than substituting a different column.`
    )
  }

  return {
    space: context.spaceKey,
    query: context.query,
    probe_limit: DISCOVERY_LIMIT,
    columns: described,
    // Only the types actually in play: the columns already chosen, everything on offer, and the types
    // the notes merely NAME (Jira relationships, Zephyr Scale, Xray, calculations — never candidates,
    // see CandidateSet.mentioned). Announcing a possible column without saying what it means is what
    // makes a model refuse a request it could satisfy.
    legend: columnLegend([
      ...columns.map((column) => column.step.type),
      ...translated.flatMap(({ set }) => [...set.candidates.map((candidate) => candidate.type), ...set.mentioned]),
    ]),
    notes,
  }
}

// --- Validation + persistence -------------------------------------------------------------------

export const MatrixSaveReportSchema = z.object({
  saved: z.boolean().describe("Whether the saved query was written"),
  matrix_id: z.number().int().nullish().describe("ID of the saved matrix (absent if the API returned no body)"),
  name: z.string(),
  space: z.string(),
  query: z.string().describe("The RQL query, stored both at the root of the saved matrix and inside its definition"),
  columns: z
    .array(
      z.object({
        column_index: z.number().int(),
        parent_column_index: z.number().int(),
        type: z.string(),
        // "" for the step types that carry no value (see NO_STEP_VALUE) — never null.
        value: z.string(),
        label: z.string(),
      })
    )
    .describe("The validated columns, in definition order (column 0 is the requirements column)"),
  warnings: z.array(z.string()).describe("Columns kept but not fully verifiable against the suggestions"),
  problems: z
    .array(z.string())
    .describe("Why nothing was saved: columns the data does not support. Fix them and call again"),
})

export type MatrixSaveReport = z.infer<typeof MatrixSaveReportSchema>

export type SaveMatrixInput = MatrixContext & {
  name: string
  description?: string
  columns: ColumnRequest[]
  limit?: number
  sharedLevel?: SharedLevel
  status?: MatrixStatus
  // Set to update an existing saved matrix in place instead of creating a new one.
  matrixId?: number
  firstColumnLabel?: string
}

// Builds the DTOSavedMatrix body.
//
// Two subtleties are handled here, and nowhere else:
//   - `json` is a STRING holding the serialised definition, not a nested object;
//   - `query` is duplicated: once at the root (the backend filters saved matrices on it) and once
//     inside `json` (what actually runs). Both are read from the SAME definition here, so the two
//     cannot drift into a matrix that lists differently from how it executes.
export function toSavedMatrixPayload(input: {
  name: string
  description?: string
  definition: MatrixDefinition
  sharedLevel?: SharedLevel
  status?: MatrixStatus
  id?: number
}): SavedMatrixPayload {
  const description = input.description?.trim()
  return {
    ...(input.id !== undefined ? { id: input.id } : {}),
    name: input.name.trim(),
    ...(description ? { description } : {}),
    spaceKey: input.definition.spaceKey,
    type: MATRIX_TYPE.traceability,
    json: JSON.stringify(input.definition),
    query: input.definition.query,
    sharedLevel: input.sharedLevel ?? "NONE",
    // A saved query is ACTIVE unless the caller says otherwise: ARCHIVED to retire it without losing
    // it, DELETED for a soft delete. Defaulted here so create and update send the same thing.
    status: input.status ?? "ACTIVE",
  }
}

// --- What an update must not silently reset ------------------------------------------------------

// A save carrying a `matrixId` is a full PUT: every field the caller does not restate would be
// rewritten with this service's own defaults. "Add a Priority column to my shared matrix 42" would
// therefore un-share it, drop its description, reset a custom limit, drop its variant filter and
// bring an ARCHIVED matrix back to life — none of which the user asked for. So the stored matrix is
// read first and its own values become the fallbacks; only what the caller states actually changes.
export type PreservedFields = {
  description?: string
  sharedLevel?: SharedLevel
  status?: MatrixStatus
  limit?: number
  variants?: number[]
}

// `sharedLevel` and `status` come back as plain strings (the read path is lenient on purpose, so a
// matrix with an unknown status stays readable). One this build does not know about is dropped rather
// than echoed back: the default then applies, which is no worse than not preserving at all.
const knownSharedLevel = (value: string | null | undefined): SharedLevel | undefined =>
  SHARED_LEVELS.find((level) => level === value)

const knownStatus = (value: string | null | undefined): MatrixStatus | undefined =>
  MATRIX_STATUSES.find((status) => status === value)

export function preservedFields(saved: SavedMatrix): PreservedFields {
  let stored: StoredMatrixDefinition | undefined
  try {
    stored = parseStoredDefinition(saved)
  } catch {
    // A definition we cannot parse must not block the update: re-saving is exactly how a matrix
    // broken in the UI gets repaired. It only costs the two definition-level fallbacks below.
    stored = undefined
  }
  const limit = stored?.limit
  return {
    ...(saved.description?.trim() ? { description: saved.description.trim() } : {}),
    ...(knownSharedLevel(saved.sharedLevel) ? { sharedLevel: knownSharedLevel(saved.sharedLevel) } : {}),
    ...(knownStatus(saved.status) ? { status: knownStatus(saved.status) } : {}),
    ...(typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? { limit } : {}),
    ...(stored?.variants ? { variants: stored.variants } : {}),
  }
}

function summarize(columns: MatrixColumn[]): MatrixSaveReport["columns"] {
  return columns.map((column) => ({
    column_index: column.columnIndex,
    parent_column_index: column.parentColumnIndex,
    type: column.step.type,
    value: column.step.value,
    label: column.label,
  }))
}

// Validates every column against live suggestions, then — only if all of them hold up — writes the
// saved query. Nothing is persisted when a single column is rejected: a matrix that renders empty is
// worse than no matrix, because it looks like it worked.
export async function saveTraceabilityMatrix(input: SaveMatrixInput): Promise<MatrixSaveReport> {
  const { api = ryClient() } = input
  const name = input.name.trim()
  const report = (extra: Partial<MatrixSaveReport>): MatrixSaveReport => ({
    saved: false,
    name,
    space: input.spaceKey,
    query: input.query,
    columns: [],
    warnings: [],
    problems: [],
    ...extra,
  })

  // A blank name passes `min(1)` at the frontier ("   " is a string of length 3) and would be stored
  // as "", i.e. a saved matrix nobody can find again in the list.
  if (!name) {
    return report({ problems: ["A saved matrix needs a name, and the one given is blank."] })
  }
  if (input.columns.length === 0) {
    return report({ problems: ["A matrix needs at least one column besides the requirements column."] })
  }
  if (input.columns.length > MAX_COLUMNS) {
    return report({
      problems: [
        `${input.columns.length} columns requested; ${MAX_COLUMNS} is the maximum (each one costs a validation round trip). Split the matrix or drop columns.`,
      ],
    })
  }

  // Read the matrix an update targets BEFORE anything else, so what the caller left out keeps the
  // value it already had (see preservedFields) and a bad id costs no validation round trip.
  // Deliberately NOT caught: if the matrix cannot be read we cannot preserve anything, and failing
  // loudly is better than quietly overwriting the user's sharing, description and limit.
  const stored: PreservedFields =
    input.matrixId !== undefined
      ? preservedFields(await api.getSavedMatrix(input.matrixId, input.instanceBaseUrl))
      : {}

  const description = input.description ?? stored.description
  const sharedLevel = input.sharedLevel ?? stored.sharedLevel
  const status = input.status ?? stored.status
  const limit = input.limit ?? stored.limit ?? DEFAULT_MATRIX_LIMIT
  // The variants the saved definition will carry — and therefore the ones every validation probe must
  // use too, or a column would be checked against data the finished matrix will not show.
  const context = { ...input, variants: input.variants ?? stored.variants }

  const carried = [
    input.description === undefined && stored.description !== undefined ? "description" : "",
    input.sharedLevel === undefined && stored.sharedLevel !== undefined ? "shared_level" : "",
    input.status === undefined && stored.status !== undefined ? "status" : "",
    input.limit === undefined && stored.limit !== undefined ? "limit" : "",
    input.variants == null && stored.variants !== undefined ? "variants" : "",
  ].filter(Boolean)

  const columns: MatrixColumn[] = [firstColumn(input.firstColumnLabel)]
  const warnings: string[] = carried.length
    ? [
        `Updating saved matrix ${input.matrixId}: an update rewrites the whole matrix, and you did not restate ${carried.join(", ")} — the stored value was kept for each. Pass them explicitly if the user wants them changed.`,
      ]
    : []

  for (const [position, request] of input.columns.entries()) {
    const columnIndex = position + 1
    const parentColumnIndex = request.parentColumnIndex ?? 0

    // Probe the matrix WITHOUT this column: the state whose suggestions describe what may be added
    // to it (and in which the all* flags still mean "not used yet").
    const probe = await api.generateTraceabilityMatrix({
      matrix: matrixDefinition(context, columns, DISCOVERY_LIMIT),
      variableValues: input.variableValues,
      instanceBaseUrl: input.instanceBaseUrl,
    })
    const suggestion = probe.columnSuggestions?.[parentColumnIndex]
    if (!suggestion) {
      return report({
        columns: summarize(columns),
        warnings,
        problems: [
          `The API returned no suggestions for column ${parentColumnIndex}, so column ${columnIndex} (${request.type}) could not be checked. Nothing was saved. Re-run discover_matrix_columns: a query that matches no requirement has no vocabulary.`,
        ],
      })
    }

    const resolution = resolveColumn(request, suggestion, columnIndex)
    if (!resolution.ok) {
      const described = `column ${columnIndex} (${request.type}${request.value ? ` "${request.value}"` : ""})`
      return report({
        columns: summarize(columns),
        warnings,
        // Stop at the FIRST rejection rather than collecting them all: the later columns' parent
        // indexes point at positions in this list, so once one is dropped the rest describe a tree
        // that no longer exists. Reporting a cascade of consequences would bury the real problem.
        problems: [
          `Rejected ${described}: ${resolution.problem}`,
          "Nothing was saved. Validation stops at the first rejected column because the following columns' parent_column_index refer to positions in the list. Call discover_matrix_columns to see what the data really offers, fix the plan, and try again.",
        ],
      })
    }
    columns.push(resolution.column)
    warnings.push(...resolution.warnings)
  }

  const definition = matrixDefinition(context, columns, limit)
  const payload = toSavedMatrixPayload({
    name,
    description,
    definition,
    sharedLevel,
    status,
    id: input.matrixId,
  })

  const saved =
    input.matrixId !== undefined
      ? await api.updateSavedMatrix(input.matrixId, payload, input.instanceBaseUrl)
      : await api.createSavedMatrix(payload, input.instanceBaseUrl)

  return report({
    saved: true,
    matrix_id: saved.id ?? input.matrixId,
    columns: summarize(columns),
    warnings,
  })
}

export function formatSaveReport(report: MatrixSaveReport): string {
  const columns = report.columns
    .map((column) =>
      `  [${column.column_index}] ${column.type}${column.value ? ` "${column.value}"` : ""} — "${column.label}" (under column ${column.parent_column_index})`
    )
    .join("\n")

  if (!report.saved) {
    return [
      `Nothing was saved: the matrix definition did not hold up against the data in space ${report.space}.`,
      ...report.problems,
      columns ? `Columns validated before stopping:\n${columns}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  return [
    `Saved the traceability matrix "${report.name}"${report.matrix_id != null ? ` (id ${report.matrix_id})` : " (the API returned no id)"} in space ${report.space}.`,
    `Query: ${report.query}`,
    `Columns:\n${columns}`,
    report.warnings.length ? `Warnings:\n${report.warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
    "Every column above was checked against the columnSuggestions the API returned for its parent, so the matrix is not silently empty.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

// --- Reading back -------------------------------------------------------------------------------

export const SavedMatrixReadingSchema = z.object({
  id: z.number().int().nullish(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  space: z.string().nullish(),
  type: z.string().nullish(),
  shared_level: z.string().nullish(),
  status: z.string().nullish(),
  query: z.string().nullish().describe("The query stored at the root of the saved matrix"),
  definition: z.unknown().describe("The matrix definition, parsed out of the `json` string"),
  warnings: z.array(z.string()),
})

export type SavedMatrixReading = z.infer<typeof SavedMatrixReadingSchema>

// The definition travels as a STRING in `json`, so reading a saved matrix means parsing it. A
// missing or unparseable `json` is a response this MCP cannot make sense of, hence RyResponseError
// (the tool turns it into a failure carrying that class's guidance).
export function parseStoredDefinition(saved: SavedMatrix): StoredMatrixDefinition {
  if (!saved.json) {
    throw new RyResponseError(
      `Saved matrix ${saved.id ?? "(no id)"} came back without its \`json\` definition, so there is nothing to read.`,
      "GET /rest/saved-matrices/{id}"
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(saved.json)
  } catch {
    throw new RyResponseError(
      `The \`json\` field of saved matrix ${saved.id ?? "(no id)"} is not valid JSON: ${saved.json.slice(0, 200)}`,
      "GET /rest/saved-matrices/{id}"
    )
  }
  const definition = StoredMatrixDefinitionSchema.safeParse(parsed)
  if (!definition.success) {
    throw new RyResponseError(
      `The definition stored in saved matrix ${saved.id ?? "(no id)"} does not look like a matrix definition: ${definition.error.issues[0]?.message ?? "shape mismatch"}.`,
      "GET /rest/saved-matrices/{id}"
    )
  }
  return definition.data
}

export function readSavedMatrix(saved: SavedMatrix): SavedMatrixReading {
  const definition = parseStoredDefinition(saved)
  const warnings: string[] = []

  // The query lives in two places by design. If they disagree the matrix lists under one query and
  // runs another — worth surfacing, because it is invisible from the UI.
  if ((saved.query ?? "") !== (definition.query ?? "")) {
    warnings.push(
      `The query at the root of the saved matrix (${JSON.stringify(saved.query ?? null)}) differs from the one inside its definition (${JSON.stringify(definition.query ?? null)}). The definition's query is what runs; the root one is what the saved-matrix list filters on. Re-save the matrix to bring them back in sync.`
    )
  }
  if (!definition.columns?.length) {
    warnings.push("The stored definition has no columns, so this matrix cannot render anything.")
  }

  return {
    id: saved.id,
    name: saved.name,
    description: saved.description,
    space: saved.spaceKey,
    type: saved.type,
    shared_level: saved.sharedLevel,
    status: saved.status,
    query: saved.query,
    definition,
    warnings,
  }
}

export const SavedMatrixListSchema = z.object({
  total: z.number().nullish().describe("Total number of matching saved matrices, when the API reports it"),
  returned: z.number().int(),
  offset: z.number().int(),
  matrices: z.array(
    z.object({
      id: z.number().int().nullish(),
      name: z.string().nullish(),
      description: z.string().nullish(),
      space: z.string().nullish(),
      type: z.string().nullish(),
      status: z.string().nullish(),
      shared_level: z.string().nullish(),
      query: z.string().nullish(),
    })
  ),
})

export type SavedMatrixList = z.infer<typeof SavedMatrixListSchema>

export type ListMatricesOptions = {
  filters: SavedMatrixFilters
  offset?: number
  limit?: number
  instanceBaseUrl?: string
  api?: TraceabilityApi
}

// The list stays a SUMMARY: the `json` definition of every matrix would be a wall of text, and the
// caller reads a single one back with get_traceability_matrix once it knows which id it wants.
export async function listSavedMatrices(options: ListMatricesOptions): Promise<SavedMatrixList> {
  const { api = ryClient() } = options
  const page = await api.searchSavedMatrices({
    filters: options.filters,
    offset: options.offset,
    limit: options.limit,
    instanceBaseUrl: options.instanceBaseUrl,
  })
  return {
    total: page.total,
    returned: page.items.length,
    offset: options.offset ?? 0,
    matrices: page.items.map((matrix) => ({
      id: matrix.id,
      name: matrix.name,
      description: matrix.description,
      space: matrix.spaceKey,
      type: matrix.type,
      status: matrix.status,
      shared_level: matrix.sharedLevel,
      query: matrix.query,
    })),
  }
}
