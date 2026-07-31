// The traceability-column vocabulary: turning what the API SUGGESTS into what a matrix definition
// must CONTAIN, and refusing anything the data doesn't actually support.
//
// This is where the intelligence of the feature lives, and it is pure (no HTTP): a suggestion set
// goes in, candidate columns or a rejection comes out. The orchestration around it — which probe to
// POST, in what order — is services/traceabilityMatrix.ts.
//
// Why the validation matters at all: the backend validates exactly ONE thing about a matrix
// definition, that `columns` is non-empty. A column naming a relationship or a property that does
// not exist in the data is persisted happily and only shows up later as an empty matrix. So a saved
// query is only as relevant as the check we do here.
//
// Three traps are handled explicitly, each with a test in tests/services/matrixColumns.test.ts:
//   1. the FROM/TO inversion (SUGGESTION_SIDE_TO_STEP_TYPE below);
//   2. the all* flags mean "already used", never "not supported" (ALL_STEP_FLAGS below);
//   3. suggestions are derived from the requirements of the current page, so the probe must use a
//      full page — that one is enforced by the caller (DISCOVERY_LIMIT).

import { columnMeaning } from "../prompts/descriptions.js"
import { ColumnSuggestionsSchema } from "../api/traceabilityDto.js"
import type {
  ColumnSuggestions,
  ExternalPropertySuggestion,
  MatrixAccumulator,
  MatrixColumn,
  MatrixStep,
  StepType,
} from "../api/traceabilityDto.js"

// !! COUNTER-INTUITIVE, AND THE NAIVE MAPPING IS WRONG !!
// A dependency suggested under `dependencySuggestions.FROM` is reached by a step of type **TO**, and
// one under `dependencySuggestions.TO` by a step of type **FROM**. The suggestion key names the
// side the existing dependency was declared from; the step names the direction the matrix walks, so
// the two are mirror images. Mapping FROM→FROM produces a syntactically valid column that matches
// nothing — and since the backend does not validate steps, nobody would tell us.
export const SUGGESTION_SIDE_TO_STEP_TYPE = {
  FROM: "TO",
  TO: "FROM",
} as const satisfies Record<"FROM" | "TO", StepType>

// The aggregate ("all of them in one column") step types and the suggestion flag that gates each.
//
// !! THESE FLAGS ARE NOT CAPABILITY FLAGS !! Their value is `!alreadyUsed`: the backend sets them
// to false once a child column of that type exists on that column. `false` therefore means "there
// is already one there", NEVER "this space does not support it" — inferring absence of support from
// a false would silently drop a perfectly valid column from what we offer the LLM.
export const ALL_STEP_FLAGS = {
  ALL_DEPENDENCIES: "allDependencies",
  ALL_PROPERTIES: "allProperties",
  ALL_EXTERNAL_PROPERTIES: "allExternalProperties",
} as const satisfies Partial<Record<StepType, keyof ColumnSuggestions>>

// Step types whose availability is a single boolean on the suggestion and that carry no value.
// (JIRA, JIRA_TYPE, JIRA_PROJECT_* and JIRA_RELATIONSHIP all hang off the same hasJiraLinks flag —
// they are different renderings of the Jira links a requirement has.)
const FLAG_GATED_STEPS = {
  LINKS: "links",
  ORIGINAL_LINKS: "originalLinks",
  DESCRIPTION: "description",
  VARIANT: "variant",
  SPACE_KEY: "spaceKey",
  TEST_CASE_VERSION: "hasTestCaseVersionLinks",
  JIRA: "hasJiraLinks",
  JIRA_TYPE: "hasJiraLinks",
  JIRA_PROJECT_NAME: "hasJiraLinks",
  JIRA_PROJECT_KEY: "hasJiraLinks",
} as const satisfies Partial<Record<StepType, keyof ColumnSuggestions>>

// Default headers, used when the caller gives no label. Types that carry a value (a relationship, a
// property, a Jira field) default to that value instead.
//
// FIRST_COLUMN ("Requirement") and JIRA ("All Jira relationships") are the labels Requirement Yogi
// itself writes, verified against a stored matrix. The rest are readable stand-ins so a generated
// matrix never ships a blank header — align one with the product's own wording whenever a real
// definition confirms it.
const DEFAULT_LABELS: Record<StepType, string> = {
  FIRST_COLUMN: "Requirement",
  TO: "Depends on",
  FROM: "Referenced by",
  ALL_DEPENDENCIES: "All dependencies",
  PROPERTY: "Property",
  ALL_PROPERTIES: "All properties",
  EXTERNAL_PROPERTY: "Property",
  ALL_EXTERNAL_PROPERTIES: "All typed properties",
  LINKS: "Links",
  ORIGINAL_LINKS: "Original links",
  JIRA: "All Jira relationships",
  JIRA_RELATIONSHIP: "Jira relationship",
  JIRA_TYPE: "Jira issue type",
  JIRA_PROJECT_NAME: "Jira project",
  JIRA_PROJECT_KEY: "Jira project key",
  CALCULATION: "Calculation",
  JIRAFIELD: "Jira field",
  ZEPHYR_SCALE: "Zephyr Scale",
  XRAY: "Xray",
  DESCRIPTION: "Description",
  VARIANT: "Variant",
  SPACE_KEY: "Space",
  TEST_CASE_VERSION: "Test case version",
}

// What a step's `value` is when its type carries none. The backend tolerates null too, but every
// definition Requirement Yogi writes itself uses the empty string — verified against a matrix stored
// in the database — so this MCP writes exactly what the product writes.
export const NO_STEP_VALUE = ""

// A column as the caller asks for it: what to add, and under which existing column.
export type ColumnRequest = {
  type: StepType
  value?: string | null
  label?: string
  // Defaults to 0 (a child of the root column).
  parentColumnIndex?: number
  hidden?: boolean
  accumulator?: MatrixAccumulator
}

// A column the API says can be added under `parentColumnIndex`, ready to be sent back as a
// ColumnRequest. Snake_case because this crosses the MCP frontier verbatim.
export type ColumnCandidate = {
  parent_column_index: number
  type: StepType
  // NO_STEP_VALUE for the types that carry none — never null, so the caller can pass a candidate
  // straight back as a column request without tripping over a type it never sent.
  value: string
  suggested_label: string
}

// What the column types in play MEAN, keyed by type. A step type is an enum name and tells the model
// nothing on its own: without this, "add the pages where the requirements are written" gets answered
// with "I can't do that" while ORIGINAL_LINKS sits right there in the candidates.
//
// It is built per RESPONSE and not per candidate on purpose: a space with 40 properties would
// otherwise repeat the same sentence 40 times. The text itself lives in src/prompts/matrix_columns.md.
export function columnLegend(types: Iterable<StepType>): Record<string, string> {
  const legend: Record<string, string> = {}
  for (const type of [...new Set(types)].sort()) legend[type] = columnMeaning(type)
  return legend
}

export type CandidateSet = {
  candidates: ColumnCandidate[]
  // What the suggestion set says WITHOUT offering a column: notably an all* flag that is false
  // because such a column already exists (which is not the same as unsupported).
  notes: string[]
  // The step types the notes NAME without offering them as candidates (a Jira relationship whose
  // names the API does not enumerate, Zephyr Scale, Xray, a calculation, an already-attached
  // aggregate). They belong in the legend too: a type announced as possible but never explained is
  // exactly what makes a model answer "I can't do that".
  mentioned: StepType[]
}

export type ColumnResolution =
  | { ok: true; column: MatrixColumn; warnings: string[] }
  | { ok: false; problem: string }

// Structural problems that need no API call to spot: a requested FIRST_COLUMN, or a
// parent_column_index that doesn't point at an already-existing column. Checked up front so an
// impossible column tree never costs a matrix generation round trip.
//
// Column N of the definition is `requests[N - 1]` (column 0 is the injected root), and the tree is
// built left to right, so a parent index must be < the column's own index.
export function structuralProblems(requests: ColumnRequest[]): string[] {
  const problems: string[] = []
  requests.forEach((request, position) => {
    const columnIndex = position + 1
    if (request.type === "FIRST_COLUMN") {
      problems.push(
        `Column ${columnIndex}: FIRST_COLUMN is column 0 and is added automatically — do not request it.`
      )
      return
    }
    const parentColumnIndex = request.parentColumnIndex ?? 0
    if (!Number.isInteger(parentColumnIndex) || parentColumnIndex < 0 || parentColumnIndex >= columnIndex) {
      problems.push(
        `Column ${columnIndex}: parent_column_index ${parentColumnIndex} does not point at an existing column (it must be between 0 and ${columnIndex - 1}).`
      )
    }
  })
  return problems
}

// Column 0 is a structural invariant: it always exists, it always holds the requirements the query
// returned, and it is its OWN parent (parentColumnIndex 0 === columnIndex 0).
export function firstColumn(label?: string): MatrixColumn {
  return {
    label: label?.trim() || DEFAULT_LABELS.FIRST_COLUMN,
    step: { type: "FIRST_COLUMN", value: NO_STEP_VALUE },
    columnIndex: 0,
    parentColumnIndex: 0,
    hidden: false,
  }
}

function cleaned(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

// Assembles the definition-level column once its step is settled: the label falls back to the one
// the API itself uses for that value when we have it (`suggestedLabel`), then to the step's own value
// (a relationship or property name reads better as a header than a generic word), then to the type's
// default.
function columnFrom(
  request: ColumnRequest,
  step: MatrixStep,
  columnIndex: number,
  suggestedLabel?: string
): MatrixColumn {
  return {
    // `cleaned` rather than `??` on the step value: NO_STEP_VALUE is a present-but-empty string, and
    // `??` would keep it and label the column "".
    label: cleaned(request.label) ?? cleaned(suggestedLabel) ?? cleaned(step.value) ?? DEFAULT_LABELS[request.type],
    step,
    columnIndex,
    parentColumnIndex: request.parentColumnIndex ?? 0,
    hidden: request.hidden ?? false,
  }
}

// Builds a column WITHOUT checking it against any suggestion. This exists for the discovery probe
// only — the matrix we POST to learn what can hang under the columns the caller already picked.
// Never use it on the path that persists a matrix: that is what resolveColumn is for, and skipping
// it is exactly how an empty-but-accepted matrix gets saved.
export function draftColumn(request: ColumnRequest, columnIndex: number): MatrixColumn {
  const step: MatrixStep = { type: request.type, value: cleaned(request.value) ?? NO_STEP_VALUE }
  if (request.accumulator) step.accumulator = request.accumulator
  return columnFrom(request, step, columnIndex)
}

// Every suggestion field this module knows about. Read off the DTO schema rather than listed again,
// so the two cannot drift.
const KNOWN_SUGGESTION_FIELDS = new Set(Object.keys(ColumnSuggestionsSchema.shape))

// Suggestion fields the API sent that this MCP has no mapping for.
//
// This is what keeps the hard-coded column vocabulary honest. ColumnSuggestionsSchema is a LOOSE
// object, so an unknown field survives parsing — and reporting it turns "Requirement Yogi added a
// column type and this MCP silently never offers it" into a visible note. It costs no maintenance:
// add a field to the schema and it stops being reported.
//
// It cannot distinguish a new column offer from some other field the endpoint happens to send, so the
// note it produces is worded as a possibility, not a diagnosis.
export function unmappedSuggestionFields(suggestion: ColumnSuggestions): string[] {
  return Object.keys(suggestion)
    .filter((field) => !KNOWN_SUGGESTION_FIELDS.has(field))
    .sort()
}

function relationshipNames(suggestion: ColumnSuggestions, side: "FROM" | "TO"): string[] {
  const entries = suggestion.dependencySuggestions?.[side] ?? []
  return [...new Set(entries.map((entry) => cleaned(entry.relationship)).filter((name): name is string => !!name))]
}

function propertyNames(suggestion: ColumnSuggestions): string[] {
  return [
    ...new Set(
      (suggestion.propertySuggestions ?? [])
        .map((entry) => cleaned(entry.property))
        .filter((name): name is string => !!name)
    ),
  ]
}

function externalProperties(suggestion: ColumnSuggestions): { name: string; suggestion: ExternalPropertySuggestion }[] {
  const found: { name: string; suggestion: ExternalPropertySuggestion }[] = []
  for (const entry of suggestion.externalPropertySuggestions ?? []) {
    const name = cleaned(entry.property)
    if (name && !found.some((seen) => seen.name === name)) found.push({ name, suggestion: entry })
  }
  return found
}

function jiraFieldKeys(suggestion: ColumnSuggestions): { key: string; label?: string }[] {
  const found: { key: string; label?: string }[] = []
  for (const entry of suggestion.jiraFields ?? []) {
    const key = cleaned(entry.value)
    if (key && !found.some((seen) => seen.key === key)) found.push({ key, label: cleaned(entry.label) })
  }
  return found
}

// Best-effort match inside a list whose element shape is NOT part of the documented contract
// (Zephyr Scale / Xray). A hit is a hit; a miss proves nothing (it may just be a shape we don't
// read), so callers warn rather than reject — see resolveColumn.
function looselyContains(entries: unknown[] | null | undefined, value: string): boolean {
  const needle = value.trim().toLowerCase()
  return (entries ?? []).some((entry) => {
    if (typeof entry === "string") return entry.trim().toLowerCase() === needle
    if (entry && typeof entry === "object") {
      return ["value", "name", "label", "type", "id"].some((field) => {
        const candidate = (entry as Record<string, unknown>)[field]
        return typeof candidate === "string" && candidate.trim().toLowerCase() === needle
      })
    }
    return false
  })
}

// Every column the API offers under `parentColumnIndex`, translated into ready-to-use requests.
//
// What is NOT offered is as informative as what is, so anything skipped for a reason the caller
// could misread lands in `notes` instead of vanishing.
export function candidatesFor(suggestion: ColumnSuggestions, parentColumnIndex: number): CandidateSet {
  const candidates: ColumnCandidate[] = []
  const notes: string[] = []
  // Every type a note names, so the legend covers it as well — see CandidateSet.mentioned.
  const mentioned: StepType[] = []
  const note = (type: StepType, text: string) => {
    mentioned.push(type)
    notes.push(text)
  }
  const add = (type: StepType, value: string, label?: string) =>
    candidates.push({
      parent_column_index: parentColumnIndex,
      type,
      value,
      suggested_label: cleaned(label) ?? cleaned(value) ?? DEFAULT_LABELS[type],
    })

  // Dependencies — mind the inversion.
  for (const side of ["FROM", "TO"] as const) {
    for (const name of relationshipNames(suggestion, side)) add(SUGGESTION_SIDE_TO_STEP_TYPE[side], name)
  }

  for (const name of propertyNames(suggestion)) add("PROPERTY", name)
  for (const { name } of externalProperties(suggestion)) add("EXTERNAL_PROPERTY", name)
  for (const { key, label } of jiraFieldKeys(suggestion)) add("JIRAFIELD", key, label ?? key)

  // The aggregate columns. A false flag means one is already attached HERE — say so rather than
  // leaving the caller to conclude the space doesn't support it (it does).
  for (const [type, flag] of Object.entries(ALL_STEP_FLAGS) as [StepType, keyof ColumnSuggestions][]) {
    const value = suggestion[flag]
    if (value === true) add(type, NO_STEP_VALUE)
    else if (value === false) {
      note(
        type,
        `Column ${parentColumnIndex}: \`${flag}\` is false, which means a ${type} column is ALREADY attached to it — not that the data does not support it.`
      )
    }
  }

  for (const [type, flag] of Object.entries(FLAG_GATED_STEPS) as [StepType, keyof ColumnSuggestions][]) {
    if (suggestion[flag] === true) add(type, NO_STEP_VALUE)
  }

  // Gated by hasJiraLinks like the other Jira renderings, but it needs the name of a Jira
  // relationship, which the suggestions do not enumerate — flagged so the caller knows to ask.
  if (suggestion.hasJiraLinks === true) {
    note(
      "JIRA_RELATIONSHIP",
      `Column ${parentColumnIndex}: JIRA_RELATIONSHIP is also possible, with the name of a Jira relationship as its value — the suggestions do not list those names, so confirm it with the user (list_relationships shows the relationships Requirement Yogi knows).`
    )
  }

  if (suggestion.hasMoreJiraFields === true) {
    notes.push(
      `Column ${parentColumnIndex}: the Jira field list is truncated (hasMoreJiraFields). A field key that is not listed may still exist.`
    )
  }

  // Zephyr Scale / Xray: gated by their own flag, but the element shape of the field lists is not
  // part of the documented contract, so the raw lists are echoed rather than translated.
  if (suggestion.hasZephyrScale === true) {
    note(
      "ZEPHYR_SCALE",
      `Column ${parentColumnIndex}: ZEPHYR_SCALE columns are possible; its value is a Zephyr Scale object type. Raw zephyrScaleFields: ${JSON.stringify(suggestion.zephyrScaleFields ?? [])}`
    )
  }
  if (suggestion.hasXray === true) {
    note(
      "XRAY",
      `Column ${parentColumnIndex}: XRAY columns are possible. Raw xrayFields: ${JSON.stringify(suggestion.xrayFields ?? [])}`
    )
  }

  if (suggestion.hasCalculations === true) {
    note(
      "CALCULATION",
      `Column ${parentColumnIndex}: CALCULATION columns are possible; the formula is its value and comes from the user, it is never suggested.`
    )
  }

  return { candidates, notes, mentioned }
}

// Human-readable "here is what you could have used instead", so a rejection teaches rather than
// just refusing. Kept to the values of the SAME step type — the whole list would be noise.
function availableFor(suggestion: ColumnSuggestions, type: StepType): string {
  const values = candidatesFor(suggestion, 0)
    .candidates.filter((candidate) => candidate.type === type)
    .map((candidate) => candidate.value)
    .filter((value) => !!value)
  return values.length ? ` Available for ${type}: ${values.join(", ")}.` : ` No ${type} value is available there.`
}

function reject(problem: string): ColumnResolution {
  return { ok: false, problem }
}

// Validates ONE requested column against the suggestions of the column it would hang under, and —
// when it holds up — returns the column to put in the definition, enriched with whatever the
// suggestion carries: an external property's enum values, and the human label the API gives a Jira
// field (without which an unlabelled column ships headed "customfield_10032").
//
// `suggestion` must be the entry for `request.parentColumnIndex` of a matrix that does NOT yet
// contain this column: that is the state in which the flags are meaningful (see ALL_STEP_FLAGS).
export function resolveColumn(
  request: ColumnRequest,
  suggestion: ColumnSuggestions,
  columnIndex: number
): ColumnResolution {
  const parentColumnIndex = request.parentColumnIndex ?? 0
  const warnings: string[] = []
  const value = cleaned(request.value)
  // The header the API itself uses for this value, when the suggestions carry one. Only Jira fields
  // have a label distinct from their value (a key like `customfield_10032`), so this stays undefined
  // for every other type and the label falls back to the value as before.
  let suggestedLabel: string | undefined

  if (request.type === "FIRST_COLUMN") {
    return reject(
      "FIRST_COLUMN is column 0 and is added automatically — do not request it. Every other column hangs under it via parent_column_index."
    )
  }
  if (!Number.isInteger(parentColumnIndex) || parentColumnIndex < 0 || parentColumnIndex >= columnIndex) {
    return reject(
      `parent_column_index ${parentColumnIndex} is invalid for the column at index ${columnIndex}: a column must hang under an EXISTING column, so its parent index must be between 0 and ${columnIndex - 1}.`
    )
  }

  // The step, filled in per type below.
  let step: MatrixStep

  switch (request.type) {
    case "TO":
    case "FROM": {
      // The mirror image: a TO step is offered under dependencySuggestions.FROM, and vice versa.
      const side = request.type === "TO" ? "FROM" : "TO"
      if (!value) return reject(`A ${request.type} column needs the relationship name as its value.`)
      if (!relationshipNames(suggestion, side).includes(value)) {
        return reject(
          `Relationship "${value}" is not among the ${request.type} relationships of the requirements in column ${parentColumnIndex}.${availableFor(suggestion, request.type)}`
        )
      }
      step = { type: request.type, value }
      break
    }

    case "PROPERTY": {
      if (!value) return reject("A PROPERTY column needs the property key as its value.")
      if (!propertyNames(suggestion).includes(value)) {
        return reject(
          `Property "${value}" was not observed on the requirements in column ${parentColumnIndex}.${availableFor(suggestion, "PROPERTY")}`
        )
      }
      step = { type: "PROPERTY", value }
      break
    }

    case "EXTERNAL_PROPERTY": {
      if (!value) return reject("An EXTERNAL_PROPERTY column needs the property key as its value.")
      const match = externalProperties(suggestion).find((entry) => entry.name === value)
      if (!match) {
        return reject(
          `External property "${value}" was not observed on the requirements in column ${parentColumnIndex}.${availableFor(suggestion, "EXTERNAL_PROPERTY")}`
        )
      }
      // The enum values belong to the property, not to our caller: copy them from the suggestion so
      // the column renders the same as it would in the RY UI.
      step = { type: "EXTERNAL_PROPERTY", value }
      if (match.suggestion.enumValues) step.enumValues = match.suggestion.enumValues
      break
    }

    case "ALL_DEPENDENCIES":
    case "ALL_PROPERTIES":
    case "ALL_EXTERNAL_PROPERTIES": {
      const flag = ALL_STEP_FLAGS[request.type]
      const offered = suggestion[flag]
      if (offered === false) {
        // Trap: false is `alreadyUsed`, so this is a DUPLICATE, not an unsupported column.
        return reject(
          `${request.type} is already attached to column ${parentColumnIndex} as a child column (\`${flag}\` is false, which means "already used" — it does NOT mean the data lacks it). Drop the duplicate, or attach it under a different column.`
        )
      }
      if (offered !== true) {
        return reject(
          `The API did not offer ${request.type} under column ${parentColumnIndex} (\`${flag}\` was ${JSON.stringify(offered ?? null)}).`
        )
      }
      step = { type: request.type, value: NO_STEP_VALUE }
      break
    }

    case "JIRAFIELD": {
      if (!value) return reject("A JIRAFIELD column needs the Jira field key as its value (e.g. issuetype).")
      if (suggestion.hasJiraLinks !== true) {
        return reject(
          `The requirements in column ${parentColumnIndex} have no Jira links (hasJiraLinks is not true), so a Jira column would be empty.`
        )
      }
      const field = jiraFieldKeys(suggestion).find((entry) => entry.key === value)
      if (!field) {
        if (suggestion.hasMoreJiraFields === true) {
          // The list is truncated, so absence is not proof: accept, but say so.
          warnings.push(
            `Jira field "${value}" is not in the suggested list, but hasMoreJiraFields is true so the list is truncated — the column was kept and may still be valid. Confirm it renders.`
          )
        } else {
          return reject(
            `Jira field "${value}" is not among the fields available on column ${parentColumnIndex}.${availableFor(suggestion, "JIRAFIELD")}`
          )
        }
      }
      // candidatesFor hands the label out as `suggested_label`, beside the value — so a caller that
      // passes a candidate back without repeating it would otherwise header the column with the raw
      // field key. Take it from the suggestion instead of asking the caller to.
      suggestedLabel = field?.label
      step = { type: "JIRAFIELD", value }
      break
    }

    case "JIRA_RELATIONSHIP": {
      if (suggestion.hasJiraLinks !== true) {
        return reject(
          `The requirements in column ${parentColumnIndex} have no Jira links (hasJiraLinks is not true), so a Jira column would be empty.`
        )
      }
      if (!value) return reject("A JIRA_RELATIONSHIP column needs the Jira relationship name as its value.")
      // The suggestions gate the column but do not enumerate relationship names, so this value
      // cannot be checked against the data. Kept, with the uncertainty stated.
      warnings.push(
        `The Jira relationship name "${value}" could not be verified: the API's suggestions gate JIRA_RELATIONSHIP columns but do not list the relationship names. Check the column is not empty once rendered.`
      )
      step = { type: "JIRA_RELATIONSHIP", value }
      break
    }

    case "ZEPHYR_SCALE":
    case "XRAY": {
      const flag = request.type === "ZEPHYR_SCALE" ? "hasZephyrScale" : "hasXray"
      if (suggestion[flag] !== true) {
        return reject(
          `${request.type} is not available on column ${parentColumnIndex} (\`${flag}\` is not true).`
        )
      }
      const fields = request.type === "ZEPHYR_SCALE" ? suggestion.zephyrScaleFields : suggestion.xrayFields
      if (value && !looselyContains(fields, value)) {
        // The element shape of these lists is not part of the documented contract, so a miss may be
        // ours rather than the caller's: warn, never reject on it.
        warnings.push(
          `Could not confirm "${value}" against the ${flag === "hasZephyrScale" ? "zephyrScaleFields" : "xrayFields"} the API returned (${JSON.stringify(fields ?? [])}); the column was kept as requested.`
        )
      }
      step = { type: request.type, value: value ?? NO_STEP_VALUE }
      break
    }

    case "CALCULATION": {
      if (suggestion.hasCalculations !== true) {
        return reject(`Calculations are not available on column ${parentColumnIndex} (hasCalculations is not true).`)
      }
      if (!value) {
        return reject("A CALCULATION column needs the formula as its value; it comes from the user, never from the suggestions.")
      }
      step = { type: "CALCULATION", value }
      break
    }

    default: {
      // Everything left is gated by a single boolean and carries no value.
      //
      // This assignment is the EXHAUSTIVENESS CHECK for the whole switch: TypeScript has narrowed
      // request.type down to whatever no case above handled, so adding a value to STEP_TYPES without
      // giving it a case (or a FLAG_GATED_STEPS entry) fails to compile RIGHT HERE. That is
      // deliberate — a new column type must not fall through into "treated as a boolean flag", which
      // would produce a column that saves and renders nothing. Together with the Record<StepType, …>
      // maps (DEFAULT_LABELS here, COLUMN_MEANINGS in prompts/descriptions.ts), the compiler lists
      // every place a new type has to be taught about.
      const flagged: keyof typeof FLAG_GATED_STEPS = request.type
      const flag = FLAG_GATED_STEPS[flagged]
      if (suggestion[flag] !== true) {
        return reject(
          `${request.type} is not available on column ${parentColumnIndex} (\`${flag}\` is not true), so the column would be empty.`
        )
      }
      if (value) {
        warnings.push(`${request.type} columns carry no value; "${value}" was ignored.`)
      }
      step = { type: request.type, value: NO_STEP_VALUE }
      break
    }
  }

  if (request.accumulator) step.accumulator = request.accumulator

  return { ok: true, warnings, column: columnFrom(request, step, columnIndex, suggestedLabel) }
}
