import { describe, it, expect } from "vitest"
import {
  ALL_STEP_FLAGS,
  candidatesFor,
  unmappedSuggestionFields,
  draftColumn,
  firstColumn,
  resolveColumn,
  structuralProblems,
  SUGGESTION_SIDE_TO_STEP_TYPE,
  type ColumnRequest,
} from "../../src/services/matrixColumns.js"
import { ColumnSuggestionsSchema, type ColumnSuggestions } from "../../src/api/traceabilityDto.js"

// The point of this module is that a saved matrix is never silently empty. The backend validates
// only that `columns` is non-empty, so anything these tests let through is something a user would
// discover days later as a matrix with no rows.

const suggestion = (fields: Record<string, unknown>): ColumnSuggestions => ColumnSuggestionsSchema.parse(fields)

const EMPTY = suggestion({})

const ok = (resolution: ReturnType<typeof resolveColumn>) => {
  if (!resolution.ok) throw new Error(`expected the column to be accepted, got: ${resolution.problem}`)
  return resolution
}
const rejected = (resolution: ReturnType<typeof resolveColumn>) => {
  if (resolution.ok) throw new Error("expected the column to be rejected")
  return resolution.problem
}

describe("column 0", () => {
  it("is FIRST_COLUMN and its own parent", () => {
    // Both invariants matter: the root column holds the requirements the query returned, and the
    // API expects parentColumnIndex === columnIndex === 0 there rather than a null parent.
    expect(firstColumn()).toEqual({
      label: "Requirement",
      // "" and not null: that is what Requirement Yogi itself stores (see NO_STEP_VALUE).
      step: { type: "FIRST_COLUMN", value: "" },
      columnIndex: 0,
      parentColumnIndex: 0,
      hidden: false,
    })
  })

  it("cannot be requested as an extra column", () => {
    expect(structuralProblems([{ type: "FIRST_COLUMN" }])[0]).toContain("added automatically")
    expect(rejected(resolveColumn({ type: "FIRST_COLUMN" }, EMPTY, 1))).toContain("added automatically")
  })
})

describe("the FROM/TO inversion", () => {
  // THE trap of this feature. `dependencySuggestions.FROM` lists the relationships you reach with a
  // step of type TO, and vice versa. The naive 1:1 mapping compiles, saves, and renders nothing.
  const dependencies = suggestion({
    dependencySuggestions: { FROM: [{ relationship: "implements" }], TO: [{ relationship: "is tested by" }] },
  })

  it("maps the suggestion side to the MIRROR step type", () => {
    expect(SUGGESTION_SIDE_TO_STEP_TYPE).toEqual({ FROM: "TO", TO: "FROM" })
  })

  it("offers a FROM-suggested relationship as a TO column, and the other way round", () => {
    const { candidates } = candidatesFor(dependencies, 0)
    expect(candidates).toEqual(
      expect.arrayContaining([
        { parent_column_index: 0, type: "TO", value: "implements", suggested_label: "implements" },
        { parent_column_index: 0, type: "FROM", value: "is tested by", suggested_label: "is tested by" },
      ])
    )
  })

  it("accepts a TO column for a relationship suggested under FROM", () => {
    expect(ok(resolveColumn({ type: "TO", value: "implements" }, dependencies, 1)).column.step).toEqual({
      type: "TO",
      value: "implements",
    })
  })

  it("REJECTS the naive same-name mapping", () => {
    // "implements" is suggested under FROM, so it is reachable as TO — never as FROM.
    expect(rejected(resolveColumn({ type: "FROM", value: "implements" }, dependencies, 1))).toContain(
      "is not among the FROM relationships"
    )
    expect(rejected(resolveColumn({ type: "TO", value: "is tested by" }, dependencies, 1))).toContain(
      "is not among the TO relationships"
    )
  })

  it("names the values that WERE available, so the caller can correct itself", () => {
    expect(rejected(resolveColumn({ type: "TO", value: "covers" }, dependencies, 1))).toContain(
      "Available for TO: implements"
    )
  })

  it("needs a relationship name", () => {
    expect(rejected(resolveColumn({ type: "TO" }, dependencies, 1))).toContain("needs the relationship name")
  })
})

describe("the all* flags", () => {
  // Second trap: these are `!alreadyUsed`, not capability flags. Reading a false as "unsupported"
  // would drop a valid column from what we offer; reading it as "available" would save a duplicate.
  it("covers the three aggregate step types", () => {
    expect(ALL_STEP_FLAGS).toEqual({
      ALL_DEPENDENCIES: "allDependencies",
      ALL_PROPERTIES: "allProperties",
      ALL_EXTERNAL_PROPERTIES: "allExternalProperties",
    })
  })

  it("offers the aggregate column when the flag is true", () => {
    const { candidates } = candidatesFor(suggestion({ allProperties: true }), 0)
    expect(candidates).toContainEqual({
      parent_column_index: 0,
      type: "ALL_PROPERTIES",
      value: "",
      suggested_label: "All properties",
    })
  })

  it("explains a false flag as ALREADY USED, never as unsupported", () => {
    const { candidates, notes } = candidatesFor(suggestion({ allDependencies: false }), 2)
    expect(candidates.some((candidate) => candidate.type === "ALL_DEPENDENCIES")).toBe(false)
    const note = notes.find((entry) => entry.includes("allDependencies"))
    expect(note).toContain("ALREADY attached")
    expect(note).toContain("not that the data does not support it")
    // The wording must not let a reader conclude the space lacks dependencies.
    expect(notes.join(" ")).not.toMatch(/unsupported|not supported/i)
  })

  it("rejects a duplicate aggregate column as a duplicate, and says so", () => {
    const problem = rejected(resolveColumn({ type: "ALL_PROPERTIES" }, suggestion({ allProperties: false }), 1))
    expect(problem).toContain("already attached")
    expect(problem).toContain('"already used"')
    // It must read as a duplicate to remove, never as a capability the space lacks.
    expect(problem).toContain("does NOT mean the data lacks it")
  })

  it("treats a missing flag as not offered, without claiming it is used", () => {
    const problem = rejected(resolveColumn({ type: "ALL_PROPERTIES" }, EMPTY, 1))
    expect(problem).toContain("did not offer")
    expect(problem).not.toContain("already")
  })
})

describe("properties", () => {
  const properties = suggestion({
    propertySuggestions: [{ property: "Priority" }, { property: "Owner" }, { property: "Priority" }],
    externalPropertySuggestions: [{ property: "Score", dataType: "NUMBER", enumValues: { high: { id: 1 } } }],
  })

  it("de-duplicates the suggested property names", () => {
    const values = candidatesFor(properties, 0)
      .candidates.filter((candidate) => candidate.type === "PROPERTY")
      .map((candidate) => candidate.value)
    expect(values).toEqual(["Priority", "Owner"])
  })

  it("accepts a suggested property and rejects an invented one", () => {
    expect(ok(resolveColumn({ type: "PROPERTY", value: "Priority" }, properties, 1)).column.step.value).toBe("Priority")
    expect(rejected(resolveColumn({ type: "PROPERTY", value: "Urgency" }, properties, 1))).toContain(
      "was not observed"
    )
  })

  it("copies the enum values of an external property into the step", () => {
    // They belong to the property, not to the caller: the column must render like it does in the UI,
    // and the LLM never has to carry them through the conversation.
    const column = ok(resolveColumn({ type: "EXTERNAL_PROPERTY", value: "Score" }, properties, 1)).column
    expect(column.step).toEqual({ type: "EXTERNAL_PROPERTY", value: "Score", enumValues: { high: { id: 1 } } })
  })

  it("does not confuse a plain property with an external one", () => {
    expect(rejected(resolveColumn({ type: "EXTERNAL_PROPERTY", value: "Priority" }, properties, 1))).toContain(
      "External property"
    )
    expect(rejected(resolveColumn({ type: "PROPERTY", value: "Score" }, properties, 1))).toContain("not observed")
  })
})

describe("Jira columns", () => {
  const jira = suggestion({
    hasJiraLinks: true,
    jiraFields: [{ value: "issuetype", label: "Issue type" }, { value: "status" }],
  })

  it("offers the flag-gated Jira renderings and the listed fields", () => {
    const { candidates } = candidatesFor(jira, 0)
    const types = candidates.map((candidate) => candidate.type)
    expect(types).toContain("JIRA")
    expect(types).toContain("JIRA_PROJECT_KEY")
    expect(candidates).toContainEqual({
      parent_column_index: 0,
      type: "JIRAFIELD",
      value: "issuetype",
      suggested_label: "Issue type",
    })
  })

  it("refuses any Jira column when the requirements have no Jira links", () => {
    expect(rejected(resolveColumn({ type: "JIRA_TYPE" }, EMPTY, 1))).toContain("hasJiraLinks")
    expect(rejected(resolveColumn({ type: "JIRAFIELD", value: "issuetype" }, EMPTY, 1))).toContain("no Jira links")
  })

  it("rejects an unlisted field when the list is complete", () => {
    expect(rejected(resolveColumn({ type: "JIRAFIELD", value: "customfield_1" }, jira, 1))).toContain("is not among")
  })

  it("keeps an unlisted field WITH A WARNING when the list is truncated", () => {
    // hasMoreJiraFields means absence is not proof: rejecting here would refuse a real field.
    const truncated = suggestion({ hasJiraLinks: true, jiraFields: [{ value: "status" }], hasMoreJiraFields: true })
    const resolution = ok(resolveColumn({ type: "JIRAFIELD", value: "customfield_1" }, truncated, 1))
    expect(resolution.column.step.value).toBe("customfield_1")
    expect(resolution.warnings[0]).toContain("truncated")
  })

  it("headers a Jira field with the API's own label, not the raw field key", () => {
    // The candidate carries the label in `suggested_label`, beside the value — so a caller that passes
    // it back without repeating it would otherwise ship a column headed "customfield_10032".
    const labelled = suggestion({
      hasJiraLinks: true,
      jiraFields: [{ value: "customfield_10032", label: "Story points" }],
    })
    expect(ok(resolveColumn({ type: "JIRAFIELD", value: "customfield_10032" }, labelled, 1)).column.label).toBe(
      "Story points"
    )
    // An explicit label still wins, and a field the API did not label falls back to its key.
    expect(
      ok(resolveColumn({ type: "JIRAFIELD", value: "customfield_10032", label: "SP" }, labelled, 1)).column.label
    ).toBe("SP")
    expect(ok(resolveColumn({ type: "JIRAFIELD", value: "status" }, jira, 1)).column.label).toBe("status")
  })

  it("keeps a JIRA_RELATIONSHIP but states the name could not be verified", () => {
    const resolution = ok(resolveColumn({ type: "JIRA_RELATIONSHIP", value: "is implemented by" }, jira, 1))
    expect(resolution.warnings[0]).toContain("could not be verified")
  })
})

describe("flag-gated columns", () => {
  it("offers only what the suggestion actually allows", () => {
    const { candidates } = candidatesFor(suggestion({ description: true, links: true, variant: false }), 0)
    const types = candidates.map((candidate) => candidate.type)
    expect(types).toEqual(expect.arrayContaining(["DESCRIPTION", "LINKS"]))
    expect(types).not.toContain("VARIANT")
  })

  it("refuses a column whose flag is not true, because it would render empty", () => {
    expect(rejected(resolveColumn({ type: "VARIANT" }, suggestion({ variant: false }), 1))).toContain("would be empty")
    expect(rejected(resolveColumn({ type: "TEST_CASE_VERSION" }, EMPTY, 1))).toContain("hasTestCaseVersionLinks")
  })

  it("ignores a value on a column type that carries none, and says it did", () => {
    const resolution = ok(resolveColumn({ type: "DESCRIPTION", value: "text" }, suggestion({ description: true }), 1))
    expect(resolution.column.step.value).toBe("")
    expect(resolution.warnings[0]).toContain("ignored")
  })
})

describe("calculations, Zephyr Scale and Xray", () => {
  it("needs a formula, and only when calculations are available", () => {
    expect(rejected(resolveColumn({ type: "CALCULATION", value: "SUM(x)" }, EMPTY, 1))).toContain("hasCalculations")
    const enabled = suggestion({ hasCalculations: true })
    expect(rejected(resolveColumn({ type: "CALCULATION" }, enabled, 1))).toContain("needs the formula")
    expect(ok(resolveColumn({ type: "CALCULATION", value: "SUM(x)" }, enabled, 1)).column.step.value).toBe("SUM(x)")
  })

  it("gates Zephyr Scale on its flag but warns rather than rejects on an unmatched object type", () => {
    // The element shape of zephyrScaleFields is not part of the documented contract, so a miss may
    // be our reading rather than a wrong value — rejecting on it would be a false negative.
    expect(rejected(resolveColumn({ type: "ZEPHYR_SCALE", value: "TEST_CASE" }, EMPTY, 1))).toContain("hasZephyrScale")

    const matching = suggestion({ hasZephyrScale: true, zephyrScaleFields: ["TEST_CASE"] })
    expect(ok(resolveColumn({ type: "ZEPHYR_SCALE", value: "TEST_CASE" }, matching, 1)).warnings).toEqual([])

    const unknownShape = suggestion({ hasZephyrScale: true, zephyrScaleFields: [{ weird: "TEST_CASE" }] })
    const resolution = ok(resolveColumn({ type: "ZEPHYR_SCALE", value: "TEST_CASE" }, unknownShape, 1))
    expect(resolution.column.step.value).toBe("TEST_CASE")
    expect(resolution.warnings[0]).toContain("Could not confirm")
  })

  it("accepts an Xray column with no value once the flag is set", () => {
    expect(ok(resolveColumn({ type: "XRAY" }, suggestion({ hasXray: true }), 1)).column.step.value).toBe("")
  })
})

describe("the column tree", () => {
  it("defaults a column to a child of the requirements column", () => {
    expect(ok(resolveColumn({ type: "DESCRIPTION" }, suggestion({ description: true }), 3)).column).toMatchObject({
      columnIndex: 3,
      parentColumnIndex: 0,
    })
  })

  it("refuses a parent that does not exist yet", () => {
    // parentColumnIndex must be < columnIndex: the tree is built left to right and a column cannot
    // hang under one that comes after it.
    const request: ColumnRequest = { type: "DESCRIPTION", parentColumnIndex: 2 }
    expect(rejected(resolveColumn(request, suggestion({ description: true }), 2))).toContain("must hang under an EXISTING column")
    expect(structuralProblems([{ type: "DESCRIPTION" }, { type: "DESCRIPTION", parentColumnIndex: 3 }])).toHaveLength(1)
    expect(structuralProblems([{ type: "DESCRIPTION" }, { type: "DESCRIPTION", parentColumnIndex: 1 }])).toEqual([])
  })

  it("labels a column with its value, then its type default, unless told otherwise", () => {
    const properties = suggestion({ propertySuggestions: [{ property: "Priority" }] })
    expect(ok(resolveColumn({ type: "PROPERTY", value: "Priority" }, properties, 1)).column.label).toBe("Priority")
    expect(ok(resolveColumn({ type: "PROPERTY", value: "Priority", label: "How urgent" }, properties, 1)).column.label).toBe(
      "How urgent"
    )
    expect(ok(resolveColumn({ type: "LINKS" }, suggestion({ links: true }), 1)).column.label).toBe("Links")
  })

  it("draftColumn builds a probe column without checking anything", () => {
    // Used only to POST the discovery probe: the whole point is to look UNDER a column, so it must
    // not depend on suggestions we do not have yet.
    expect(draftColumn({ type: "PROPERTY", value: " Priority ", parentColumnIndex: 1 }, 2)).toEqual({
      label: "Priority",
      step: { type: "PROPERTY", value: "Priority" },
      columnIndex: 2,
      parentColumnIndex: 1,
      hidden: false,
    })
  })

  it("carries hidden and the accumulator through", () => {
    const accumulator = { display: true, formula: "SUM(x)", dataType: "NUMBER" }
    const resolution = ok(
      resolveColumn({ type: "LINKS", hidden: true, accumulator }, suggestion({ links: true }), 1)
    )
    expect(resolution.column.hidden).toBe(true)
    expect(resolution.column.step.accumulator).toEqual(accumulator)
  })
})

// The column vocabulary is hard-coded (a suggestion field only becomes a column because code maps it
// to a step type), so the one thing that must not happen is a Requirement Yogi addition going
// unnoticed. This is the net under that.
describe("unmappedSuggestionFields", () => {
  it("sees nothing to report on a suggestion set it fully understands", () => {
    expect(unmappedSuggestionFields(suggestion({ description: true, allProperties: false }))).toEqual([])
    expect(unmappedSuggestionFields(EMPTY)).toEqual([])
  })

  it("reports a field the API sent that this build has no mapping for", () => {
    // A new column type on the backend arrives exactly like this. The DTO is a loose object, so the
    // field survives parsing and can be surfaced instead of vanishing.
    const withNewField = suggestion({ description: true, confluenceLabelSuggestions: [{ label: "x" }] })
    expect(unmappedSuggestionFields(withNewField)).toEqual(["confluenceLabelSuggestions"])
  })

  it("sorts, so the report is stable", () => {
    expect(unmappedSuggestionFields(suggestion({ zzz: 1, aaa: 2 }))).toEqual(["aaa", "zzz"])
  })

  it("stops reporting a field once the DTO declares it", () => {
    // Silencing a false positive is a one-line schema edit, not a code change here.
    expect(unmappedSuggestionFields(suggestion({ hasMoreJiraFields: true }))).toEqual([])
  })
})

describe("candidatesFor", () => {
  it("returns nothing at all for an empty suggestion set", () => {
    expect(candidatesFor(EMPTY, 0)).toEqual({ candidates: [], notes: [], mentioned: [] })
  })

  it("tags every candidate with the parent column it belongs to", () => {
    const { candidates } = candidatesFor(suggestion({ description: true, propertySuggestions: [{ property: "P" }] }), 3)
    expect(candidates.every((candidate) => candidate.parent_column_index === 3)).toBe(true)
  })

  it("echoes what it cannot translate instead of dropping it", () => {
    // Zephyr/Xray field shapes and Jira relationship names are not part of the documented contract;
    // silence there would read as "not available".
    const { notes } = candidatesFor(
      suggestion({ hasJiraLinks: true, hasZephyrScale: true, zephyrScaleFields: [{ id: "TC" }], hasCalculations: true }),
      0
    )
    expect(notes.join("\n")).toContain("JIRA_RELATIONSHIP")
    expect(notes.join("\n")).toContain("ZEPHYR_SCALE")
    expect(notes.join("\n")).toContain('{"id":"TC"}')
    expect(notes.join("\n")).toContain("CALCULATION")
  })
})
