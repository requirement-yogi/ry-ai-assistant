// Typed frontier with the traceability-matrix side of the Requirement Yogi Confluence API.
//
// Split out of dto.ts because it is a self-contained contract of its own (steps, columns, matrix
// definition, column suggestions, saved matrices) and doubling the size of dto.ts would have buried
// the linking DTOs it already holds. Same philosophy as its sibling: LOOSE objects so unknown
// fields survive into the tool result, optional/nullish for anything we are not certain the API
// always sends, and one loud located failure at the boundary instead of a silent undefined.
//
// Two things here are NOT lenient, on purpose:
//   - StepType is a CLOSED enum. The 23 values are the backend's own enum and the LLM picks one, so
//     a strict enum turns an invented step type into a validation error instead of a matrix that
//     saves fine and renders empty. Reading a matrix BACK uses the lenient
//     StoredMatrixDefinitionSchema below, so a matrix authored by a newer RY version still parses.
//   - columnSuggestions is a plain (non-lenient) array: it is indexed BY COLUMN, so dropping a
//     malformed entry the way parseApiItems does would SHIFT every following index and silently
//     validate columns against the wrong parent's vocabulary.

import { z } from "zod"

// The full DTOTraceabilityStep type enum. Closed and safe to hard-code (it is persisted inside
// saved matrices, so the backend cannot rename these without breaking its own stored data).
export const STEP_TYPES = [
  "TO",
  "FROM",
  "ALL_DEPENDENCIES",
  "PROPERTY",
  "ALL_PROPERTIES",
  "EXTERNAL_PROPERTY",
  "ALL_EXTERNAL_PROPERTIES",
  "FIRST_COLUMN",
  "LINKS",
  "ORIGINAL_LINKS",
  "JIRA",
  "JIRA_RELATIONSHIP",
  "JIRA_TYPE",
  "JIRA_PROJECT_NAME",
  "JIRA_PROJECT_KEY",
  "CALCULATION",
  "JIRAFIELD",
  "ZEPHYR_SCALE",
  "XRAY",
  "DESCRIPTION",
  "VARIANT",
  "SPACE_KEY",
  "TEST_CASE_VERSION",
] as const

export const StepTypeSchema = z.enum(STEP_TYPES)
export type StepType = (typeof STEP_TYPES)[number]

// Saved-matrix flavours; only TRACEABILITY is produced here.
export const MATRIX_TYPE = {
  traceability: "TRACEABILITY",
  modification: "MODIFICATION",
  coverage: "COVERAGE",
} as const

export const SHARED_LEVELS = ["NONE", "SHARED_VIEW", "SHARED_EDIT"] as const

export const SharedLevelSchema = z.enum(SHARED_LEVELS)
export type SharedLevel = (typeof SHARED_LEVELS)[number]

// Lifecycle of a saved matrix. DELETED is a soft delete, not a purge.
export const MATRIX_STATUSES = ["ACTIVE", "DELETED", "ARCHIVED"] as const

export const MatrixStatusSchema = z.enum(MATRIX_STATUSES)
export type MatrixStatus = (typeof MATRIX_STATUSES)[number]

// --- What we SEND: the matrix definition -------------------------------------------------------
// Plain TypeScript types rather than Zod schemas: these objects are BUILT by this MCP (services/
// matrixColumns.ts), never parsed from the outside, so the compiler is the right validator. What
// comes back from the API is parsed by the schemas further down.

// An external-property enum value and the data type of an accumulator/external property are opaque
// pass-throughs: a suggestion hands them to us and we copy them into the step verbatim, so their
// internal shape is none of our business (and inventing one would be guessing).
export type ExternalPropertyEnumValues = Record<string, unknown>

export type MatrixAccumulator = {
  display: boolean
  formula: string
  dataType: string
}

export type MatrixStep = {
  type: StepType
  // Semantics depend on `type`: relationship name (TO/FROM), property key (PROPERTY/
  // EXTERNAL_PROPERTY), formula (CALCULATION), Jira field key (JIRAFIELD), Zephyr object type
  // (ZEPHYR_SCALE) — and the EMPTY STRING for the types that carry no value (FIRST_COLUMN,
  // DESCRIPTION, VARIANT, SPACE_KEY, LINKS, JIRA, ALL_*).
  //
  // Never null: the backend accepts both, but every definition Requirement Yogi itself writes uses
  // "" (verified against a stored matrix), and matching what the product writes is what keeps a
  // matrix saved through this MCP indistinguishable from one built in the UI. See NO_STEP_VALUE.
  value: string
  accumulator?: MatrixAccumulator
  enumValues?: ExternalPropertyEnumValues
}

export type MatrixColumn = {
  label: string
  step: MatrixStep
  // Index of this column in the `columns` array — no holes allowed.
  columnIndex: number
  // The column this one hangs under: `columns` is a TREE, not a flat list. Column 0 is its own
  // parent (see FIRST_COLUMN in services/matrixColumns.ts).
  parentColumnIndex: number
  hidden: boolean
}

export type MatrixDefinition = {
  columns: MatrixColumn[]
  query: string
  // The variant ids the matrix is filtered on. Both [] and null mean "the current variant"; this MCP
  // always writes [] (see matrixDefinition) — never a null collection the backend might iterate.
  variants: number[] | null
  limit: number
  spaceKey: string
}

// --- What we RECEIVE: the column suggestions ---------------------------------------------------
// POST /rest/traceability/{spaceKey} answers with the matrix cells AND `columnSuggestions`, an
// array indexed by column: entry `i` says what can be added as a CHILD of column `i`. There is no
// "list available columns" endpoint — the backend derives these from the requirements actually
// present in that column's cells, which is why the whole vocabulary is data-dependent.
//
// The field names below are contractually stable (they are persisted in saved matrices), so they
// are typed as-is rather than probed for.

export const DependencySuggestionSchema = z.looseObject({
  relationship: z.string().nullish(),
})

export const PropertySuggestionSchema = z.looseObject({
  property: z.string().nullish(),
})

export const ExternalPropertySuggestionSchema = z.looseObject({
  property: z.string().nullish(),
  dataType: z.string().nullish(),
  enumValues: z.record(z.string(), z.unknown()).nullish(),
})

export const JiraFieldSuggestionSchema = z.looseObject({
  value: z.string().nullish(),
  label: z.string().nullish(),
  isStandard: z.boolean().nullish(),
  isCustom: z.boolean().nullish(),
})

export const ColumnSuggestionsSchema = z.looseObject({
  // WARNING: the FROM/TO keys here do NOT map onto steps of the same name — see
  // SUGGESTION_SIDE_TO_STEP_TYPE in services/matrixColumns.ts.
  dependencySuggestions: z
    .looseObject({
      FROM: z.array(DependencySuggestionSchema).nullish(),
      TO: z.array(DependencySuggestionSchema).nullish(),
    })
    .nullish(),
  // The three all* flags are NOT capability flags: they are `!alreadyUsed`. See ALL_STEP_FLAGS.
  allDependencies: z.boolean().nullish(),
  propertySuggestions: z.array(PropertySuggestionSchema).nullish(),
  allProperties: z.boolean().nullish(),
  externalPropertySuggestions: z.array(ExternalPropertySuggestionSchema).nullish(),
  allExternalProperties: z.boolean().nullish(),
  links: z.boolean().nullish(),
  description: z.boolean().nullish(),
  variant: z.boolean().nullish(),
  spaceKey: z.boolean().nullish(),
  hasJiraLinks: z.boolean().nullish(),
  hasTestCaseVersionLinks: z.boolean().nullish(),
  originalLinks: z.boolean().nullish(),
  jiraFields: z.array(JiraFieldSuggestionSchema).nullish(),
  // The jiraFields list can be truncated; when this is true an unlisted field key may still exist.
  hasMoreJiraFields: z.boolean().nullish(),
  // The element shape of the Zephyr Scale / Xray lists is not part of the documented contract, so
  // they stay `unknown[]`: they are echoed to the LLM rather than interpreted (see resolveColumn).
  zephyrScaleFields: z.array(z.unknown()).nullish(),
  hasZephyrScale: z.boolean().nullish(),
  xrayFields: z.array(z.unknown()).nullish(),
  hasXray: z.boolean().nullish(),
  hasCalculations: z.boolean().nullish(),
})

// The generation response. Only `columnSuggestions` is declared: the cells are a page of rendered
// data this MCP has no reason to interpret (the loose object keeps them for anyone who does).
export const TraceabilityResultSchema = z.looseObject({
  // The ELEMENTS are nullable, the array itself is still positional. Both are deliberate: an entry
  // the backend computed nothing for must not fail the whole response (a null reads as "nothing can
  // be attached under that column", which both consumers already handle), while DROPPING it the way
  // parseApiItems does would shift every following index and validate columns against the wrong
  // parent's vocabulary.
  columnSuggestions: z.array(ColumnSuggestionsSchema.nullable()).nullish(),
})

// --- What we RECEIVE: a saved matrix -----------------------------------------------------------

export const SavedMatrixSchema = z.looseObject({
  id: z.number().int().nullish(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  spaceKey: z.string().nullish(),
  type: z.string().nullish(),
  // A STRING holding the serialised matrix definition — not a nested object. See
  // toSavedMatrixPayload / parseStoredDefinition.
  json: z.string().nullish(),
  query: z.string().nullish(),
  sharedLevel: z.string().nullish(),
  // One of MATRIX_STATUSES, but kept as a plain string on the way IN: a status we don't know about
  // must not make a saved matrix unreadable.
  status: z.string().nullish(),
  container: z.unknown().nullish(),
})

// Lenient counterpart of MatrixDefinition, for the definition read back out of `json`. Deliberately
// looser than what we send (step.type is a plain string): a matrix authored by a newer RY version,
// or by hand in the UI, must be readable rather than rejected.
export const StoredMatrixDefinitionSchema = z.looseObject({
  columns: z
    .array(
      z.looseObject({
        label: z.string().nullish(),
        step: z
          .looseObject({
            type: z.string().nullish(),
            value: z.string().nullish(),
          })
          .nullish(),
        columnIndex: z.number().int().nullish(),
        parentColumnIndex: z.number().int().nullish(),
        hidden: z.boolean().nullish(),
      })
    )
    .nullish(),
  query: z.string().nullish(),
  variants: z.array(z.number().int()).nullish(),
  limit: z.number().nullish(),
  spaceKey: z.string().nullish(),
})

export type DependencySuggestion = z.infer<typeof DependencySuggestionSchema>
export type PropertySuggestion = z.infer<typeof PropertySuggestionSchema>
export type ExternalPropertySuggestion = z.infer<typeof ExternalPropertySuggestionSchema>
export type JiraFieldSuggestion = z.infer<typeof JiraFieldSuggestionSchema>
export type ColumnSuggestions = z.infer<typeof ColumnSuggestionsSchema>
export type TraceabilityResult = z.infer<typeof TraceabilityResultSchema>
export type SavedMatrix = z.infer<typeof SavedMatrixSchema>
export type StoredMatrixDefinition = z.infer<typeof StoredMatrixDefinitionSchema>

// The value `ownerAccountId` must carry on EVERY saved-matrix write: a sentinel telling the backend to
// fill the real account in itself. A client neither knows nor is allowed to set the owning account, so
// it says "you do it" rather than sending an id. Injected by RyClient.savedMatrixBody — deliberately
// NOT a field of SavedMatrixPayload, so no caller can substitute a real account id for it.
export const BACKEND_FILLED_ACCOUNT = "FILLED_IN_BACKEND"

// What POST/PUT /rest/saved-matrices takes. `json` is the stringified MatrixDefinition and `query`
// duplicates the definition's own query at the root (the backend filters saved matrices on it).
export type SavedMatrixPayload = {
  id?: number
  name: string
  description?: string
  spaceKey: string
  type: (typeof MATRIX_TYPE)[keyof typeof MATRIX_TYPE]
  json: string
  query: string
  sharedLevel: SharedLevel
  status: MatrixStatus
}

// RYEntityFilters, as far as POST /rest/saved-matrices/search needs it. `owned` is required.
export type SavedMatrixFilters = {
  owned: boolean
  name?: string
  matrixType?: (typeof MATRIX_TYPE)[keyof typeof MATRIX_TYPE]
  spaceKey?: string
  id?: number
}
