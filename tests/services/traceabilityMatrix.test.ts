import { describe, it, expect } from "vitest"
import {
  DEFAULT_MATRIX_LIMIT,
  DISCOVERY_LIMIT,
  MAX_COLUMNS,
  discoverMatrixColumns,
  formatSaveReport,
  listSavedMatrices,
  matrixDefinition,
  parseStoredDefinition,
  readSavedMatrix,
  saveTraceabilityMatrix,
  toSavedMatrixPayload,
  type TraceabilityApi,
} from "../../src/services/traceabilityMatrix.js"
import { SavedMatrixSchema, type MatrixDefinition, type SavedMatrixPayload } from "../../src/api/traceabilityDto.js"
import { RyResponseError } from "../../src/errors.js"
import type { MatrixGenerationOptions, SavedMatrixPageOptions } from "../../src/api/ryClient.js"

// These tests drive the two loops the feature is built on — the discovery probe and the
// column-by-column validation before persisting — against a fake client, which is exactly why the
// service takes an injectable `api`.

type Generated = { columnSuggestions?: unknown[] }

type FakeOptions = {
  // One response per generateTraceabilityMatrix call, in order.
  generated?: Generated[]
  created?: unknown
  saved?: unknown
  page?: { items: unknown[]; total?: number }
}

function fakeApi(options: FakeOptions = {}) {
  const generations: MatrixGenerationOptions[] = []
  const writes: { method: "create" | "update"; id?: number; payload: SavedMatrixPayload }[] = []
  const searches: SavedMatrixPageOptions[] = []
  const reads: number[] = []

  const api: TraceabilityApi = {
    async generateTraceabilityMatrix(request) {
      generations.push(structuredClone(request))
      return (options.generated?.[generations.length - 1] ?? { columnSuggestions: [] }) as never
    },
    async createSavedMatrix(payload) {
      writes.push({ method: "create", payload })
      return SavedMatrixSchema.parse(options.created ?? { id: 77 })
    },
    async updateSavedMatrix(id, payload) {
      writes.push({ method: "update", id, payload })
      return SavedMatrixSchema.parse(options.created ?? { id })
    },
    async getSavedMatrix(id) {
      reads.push(id)
      return SavedMatrixSchema.parse(options.saved ?? {})
    },
    async searchSavedMatrices(request) {
      searches.push(request)
      const page = options.page ?? { items: [] }
      return { items: page.items.map((item) => SavedMatrixSchema.parse(item)), total: page.total }
    },
  }
  return { api, generations, writes, searches, reads }
}

const context = (api: TraceabilityApi) => ({ spaceKey: "DEMO", query: "key ~ 'FN-%'", api })

describe("matrixDefinition", () => {
  it("sends no variant as an empty list, never as a null collection", () => {
    // [] and null both mean "the current variant", but the generation endpoint answers a payload it
    // cannot handle with a bare 500 (an unhandled exception), so we never hand it a null to iterate.
    expect(matrixDefinition({ spaceKey: "DEMO", query: "q" }, [], 200)).toEqual({
      columns: [],
      query: "q",
      variants: [],
      limit: 200,
      spaceKey: "DEMO",
    })
    expect(matrixDefinition({ spaceKey: "DEMO", query: "q", variants: null }, [], 200).variants).toEqual([])
    expect(matrixDefinition({ spaceKey: "DEMO", query: "q", variants: [4] }, [], 200).variants).toEqual([4])
  })
})

describe("discoverMatrixColumns", () => {
  it("probes with column 0 alone on the first call and translates its suggestions", async () => {
    const { api, generations } = fakeApi({
      generated: [{ columnSuggestions: [{ propertySuggestions: [{ property: "Priority" }], description: true }] }],
    })

    const discovery = await discoverMatrixColumns(context(api))

    expect(generations).toHaveLength(1)
    expect(generations[0].matrix.columns).toEqual([
      { label: "Requirement", step: { type: "FIRST_COLUMN", value: "" }, columnIndex: 0, parentColumnIndex: 0, hidden: false },
    ])
    expect(discovery.columns).toHaveLength(1)
    expect(discovery.columns[0].candidates.map((candidate) => candidate.type)).toEqual(["PROPERTY", "DESCRIPTION"])
  })

  it("ALWAYS probes with a full page, whatever the matrix will eventually render", async () => {
    // Third trap: suggestions are derived from the requirements the current page returned, so a
    // small limit yields an impoverished vocabulary and hides valid columns.
    const { api, generations } = fakeApi()
    await discoverMatrixColumns(context(api))
    expect(DISCOVERY_LIMIT).toBe(200)
    // The service sets the definition's limit; wrapping it into the request's pagination envelope
    // is the client's job (covered in tests/api/ryClient.test.ts).
    expect(generations[0].matrix.limit).toBe(DISCOVERY_LIMIT)
  })

  it("costs ONE round trip and describes every column of the probe at once", async () => {
    const { api, generations } = fakeApi({
      generated: [
        {
          columnSuggestions: [
            { dependencySuggestions: { FROM: [{ relationship: "implements" }] } },
            { propertySuggestions: [{ property: "Status" }] },
          ],
        },
      ],
    })

    const discovery = await discoverMatrixColumns(context(api), [{ type: "TO", value: "implements" }])

    expect(generations).toHaveLength(1)
    expect(generations[0].matrix.columns.map((column) => column.step)).toEqual([
      { type: "FIRST_COLUMN", value: "" },
      { type: "TO", value: "implements" },
    ])
    // Suggestions for the column just added are what let the caller go one level deeper.
    expect(discovery.columns[1].candidates).toEqual([
      { parent_column_index: 1, type: "PROPERTY", value: "Status", suggested_label: "Status" },
    ])
  })

  it("explains what every column type in the response means", async () => {
    // A step type is an enum name; without the legend the model has nothing to match a user's
    // request against, and refuses columns it could perfectly well use.
    const { api } = fakeApi({
      generated: [{ columnSuggestions: [{ originalLinks: true, propertySuggestions: [{ property: "Priority" }] }] }],
    })

    const discovery = await discoverMatrixColumns(context(api))

    // Column 0's own type plus everything on offer, once each — never repeated per candidate.
    expect(Object.keys(discovery.legend).sort()).toEqual(["FIRST_COLUMN", "ORIGINAL_LINKS", "PROPERTY"])
    expect(discovery.legend.ORIGINAL_LINKS).toContain("WRITTEN")
    expect(discovery.legend.PROPERTY).toBeTruthy()
  })

  it("does not repeat a meaning once per candidate", async () => {
    const { api } = fakeApi({
      generated: [
        { columnSuggestions: [{ propertySuggestions: [{ property: "A" }, { property: "B" }, { property: "C" }] }] },
      ],
    })
    const discovery = await discoverMatrixColumns(context(api))
    expect(discovery.columns[0].candidates).toHaveLength(3)
    expect(Object.keys(discovery.legend)).toEqual(["FIRST_COLUMN", "PROPERTY"])
  })

  it("warns once when the API offers something this build cannot map", async () => {
    const { api } = fakeApi({
      generated: [
        {
          columnSuggestions: [
            { description: true, confluenceLabelSuggestions: [] },
            { description: true, confluenceLabelSuggestions: [] },
          ],
        },
      ],
    })

    const discovery = await discoverMatrixColumns(context(api), [{ type: "DESCRIPTION" }])
    const warning = discovery.notes.filter((note) => note.includes("confluenceLabelSuggestions"))
    // Once for the whole response, not once per column that carries the field.
    expect(warning).toHaveLength(1)
    expect(warning[0]).toContain("does not map")
    expect(warning[0]).toContain("check_for_updates")
  })

  it("says nothing about unmapped fields when there are none", async () => {
    const { api } = fakeApi({ generated: [{ columnSuggestions: [{ description: true }] }] })
    const discovery = await discoverMatrixColumns(context(api))
    expect(discovery.notes.some((note) => note.includes("does not map"))).toBe(false)
  })

  it("says so when the query brings back no vocabulary at all", async () => {
    const { api } = fakeApi({ generated: [{ columnSuggestions: [] }] })
    const discovery = await discoverMatrixColumns(context(api))
    expect(discovery.notes.join(" ")).toContain("no column suggestions")
    expect(discovery.columns[0].candidates).toEqual([])
  })

  it("does not validate the columns it was given — it looks UNDER them", async () => {
    // A column that matches nothing simply comes back with no candidates; refusing it here would
    // make the tool unusable for exploring.
    const { api } = fakeApi({ generated: [{ columnSuggestions: [{}, {}] }] })
    const discovery = await discoverMatrixColumns(context(api), [{ type: "PROPERTY", value: "Invented" }])
    expect(discovery.columns[1].candidates).toEqual([])
  })

  it("passes the query variables through", async () => {
    const { api, generations } = fakeApi()
    await discoverMatrixColumns({ ...context(api), variableValues: { release: "1.2" } })
    expect(generations[0].variableValues).toEqual({ release: "1.2" })
  })

  it("reports a column the API described as null instead of failing the whole response", async () => {
    // columnSuggestions is positional, so a null entry cannot be dropped — but it must not sink the
    // call either: it means the backend computed nothing for that column, which is an answer.
    const { api } = fakeApi({
      generated: [{ columnSuggestions: [{ dependencySuggestions: { FROM: [{ relationship: "implements" }] } }, null] }],
    })

    const discovery = await discoverMatrixColumns(context(api), [{ type: "TO", value: "implements" }])

    expect(discovery.columns[0].candidates.map((candidate) => candidate.type)).toEqual(["TO"])
    expect(discovery.columns[1].candidates).toEqual([])
    expect(discovery.columns[1].notes[0]).toContain("no suggestions for this column")
  })

  it("explains the types it only offers through a note, not just the candidates", async () => {
    // ZEPHYR_SCALE, XRAY, JIRA_RELATIONSHIP and CALCULATION are never candidates (their values are
    // not enumerated), so announcing them without a legend entry is exactly the give-up case the
    // glossary exists to prevent.
    const { api } = fakeApi({
      generated: [{ columnSuggestions: [{ hasZephyrScale: true, hasXray: true, hasJiraLinks: true, hasCalculations: true }] }],
    })

    const discovery = await discoverMatrixColumns(context(api))

    expect(Object.keys(discovery.legend).sort()).toEqual(
      expect.arrayContaining(["CALCULATION", "JIRA_RELATIONSHIP", "XRAY", "ZEPHYR_SCALE"])
    )
    for (const type of ["CALCULATION", "JIRA_RELATIONSHIP", "XRAY", "ZEPHYR_SCALE"]) {
      expect(discovery.legend[type], type).toBeTruthy()
    }
  })
})

describe("saveTraceabilityMatrix", () => {
  const suggestionsFor = (...entries: unknown[]) => ({ columnSuggestions: entries })

  it("validates each column against the matrix as it stands BEFORE that column", async () => {
    // This is why validation is incremental: probing with the finished matrix would report the
    // aggregate columns we are validating as unavailable (their flags are `!alreadyUsed`).
    const { api, generations, writes } = fakeApi({
      generated: [
        suggestionsFor({ propertySuggestions: [{ property: "Priority" }], allProperties: true }),
        suggestionsFor({ propertySuggestions: [{ property: "Priority" }], allProperties: true }, {}),
      ],
    })

    const report = await saveTraceabilityMatrix({
      ...context(api),
      name: "Coverage",
      columns: [{ type: "PROPERTY", value: "Priority" }, { type: "ALL_PROPERTIES" }],
    })

    expect(report.saved).toBe(true)
    // One probe per column, each with the columns validated so far.
    expect(generations.map((generation) => generation.matrix.columns.length)).toEqual([1, 2])
    expect(generations.every((generation) => generation.matrix.limit === DISCOVERY_LIMIT)).toBe(true)
    expect(report.columns).toEqual([
      { column_index: 0, parent_column_index: 0, type: "FIRST_COLUMN", value: "", label: "Requirement" },
      { column_index: 1, parent_column_index: 0, type: "PROPERTY", value: "Priority", label: "Priority" },
      { column_index: 2, parent_column_index: 0, type: "ALL_PROPERTIES", value: "", label: "All properties" },
    ])
    expect(writes).toHaveLength(1)
    expect(writes[0].method).toBe("create")
    expect(report.matrix_id).toBe(77)
  })

  it("validates a nested column against ITS parent's suggestions, not column 0's", async () => {
    const { api, writes } = fakeApi({
      generated: [
        suggestionsFor({ dependencySuggestions: { FROM: [{ relationship: "implements" }] } }),
        suggestionsFor({ dependencySuggestions: { FROM: [{ relationship: "implements" }] } }, { description: true }),
      ],
    })

    const report = await saveTraceabilityMatrix({
      ...context(api),
      name: "Nested",
      columns: [
        { type: "TO", value: "implements" },
        { type: "DESCRIPTION", parentColumnIndex: 1 },
      ],
    })

    expect(report.saved).toBe(true)
    expect(report.columns[2]).toMatchObject({ column_index: 2, parent_column_index: 1, type: "DESCRIPTION" })
    expect(writes).toHaveLength(1)
  })

  it("WRITES NOTHING when a column does not match the data", async () => {
    // The whole point of the feature: the backend would accept this and render an empty matrix.
    const { api, writes } = fakeApi({ generated: [suggestionsFor({ propertySuggestions: [{ property: "Priority" }] })] })

    const report = await saveTraceabilityMatrix({
      ...context(api),
      name: "Broken",
      columns: [{ type: "PROPERTY", value: "Invented" }],
    })

    expect(report.saved).toBe(false)
    expect(writes).toEqual([])
    expect(report.problems[0]).toContain('Rejected column 1 (PROPERTY "Invented")')
    // The rejection carries what WAS available, so the caller can fix it in one turn.
    expect(report.problems[0]).toContain("Priority")
    expect(report.problems.join(" ")).toContain("Nothing was saved")
  })

  it("stops at the first rejection instead of reporting a cascade", async () => {
    const { api, generations } = fakeApi({ generated: [suggestionsFor({})] })
    const report = await saveTraceabilityMatrix({
      ...context(api),
      name: "Broken",
      columns: [{ type: "DESCRIPTION" }, { type: "VARIANT" }, { type: "SPACE_KEY" }],
    })
    expect(report.saved).toBe(false)
    expect(generations).toHaveLength(1)
    expect(report.problems.filter((problem) => problem.startsWith("Rejected"))).toHaveLength(1)
  })

  it("keeps the warnings of the columns it did accept", async () => {
    const { api, writes } = fakeApi({
      generated: [suggestionsFor({ hasJiraLinks: true, jiraFields: [{ value: "status" }], hasMoreJiraFields: true })],
    })
    const report = await saveTraceabilityMatrix({
      ...context(api),
      name: "Jira",
      columns: [{ type: "JIRAFIELD", value: "customfield_1" }],
    })
    expect(report.saved).toBe(true)
    expect(writes).toHaveLength(1)
    expect(report.warnings[0]).toContain("truncated")
  })

  it("refuses a matrix with no column of its own, and one that is absurdly wide", async () => {
    const { api, generations } = fakeApi()
    expect((await saveTraceabilityMatrix({ ...context(api), name: "Empty", columns: [] })).problems[0]).toContain(
      "at least one column"
    )
    const tooMany = await saveTraceabilityMatrix({
      ...context(api),
      name: "Wide",
      columns: Array.from({ length: MAX_COLUMNS + 1 }, () => ({ type: "DESCRIPTION" as const })),
    })
    expect(tooMany.problems[0]).toContain(`${MAX_COLUMNS} is the maximum`)
    // Neither case costs a single round trip.
    expect(generations).toEqual([])
  })

  it("explains a missing suggestion entry instead of saving blindly", async () => {
    const { api, writes } = fakeApi({ generated: [{ columnSuggestions: [] }] })
    const report = await saveTraceabilityMatrix({
      ...context(api),
      name: "No vocabulary",
      columns: [{ type: "DESCRIPTION" }],
    })
    expect(report.saved).toBe(false)
    expect(writes).toEqual([])
    expect(report.problems[0]).toContain("no suggestions for column 0")
  })

  it("sends the status on create and on update, defaulting to ACTIVE", async () => {
    const { api, writes } = fakeApi({ generated: [suggestionsFor({ description: true })] })
    await saveTraceabilityMatrix({ ...context(api), name: "New", columns: [{ type: "DESCRIPTION" }] })
    expect(writes[0].payload.status).toBe("ACTIVE")

    const { api: archived, writes: archivedWrites } = fakeApi({ generated: [suggestionsFor({ description: true })] })
    await saveTraceabilityMatrix({
      ...context(archived),
      name: "Old",
      columns: [{ type: "DESCRIPTION" }],
      status: "ARCHIVED",
      matrixId: 3,
    })
    expect(archivedWrites[0]).toMatchObject({ method: "update", payload: { status: "ARCHIVED" } })
  })

  it("updates in place when given a matrix id", async () => {
    const { api, writes } = fakeApi({ generated: [suggestionsFor({ description: true })] })
    const report = await saveTraceabilityMatrix({
      ...context(api),
      name: "Existing",
      columns: [{ type: "DESCRIPTION" }],
      matrixId: 12,
    })
    expect(writes[0]).toMatchObject({ method: "update", id: 12 })
    expect(writes[0].payload.id).toBe(12)
    expect(report.matrix_id).toBe(12)
  })

  it("keeps what an update does not restate, instead of resetting it", async () => {
    // An update is a full PUT. "Add a column to my shared matrix" must not un-share it, wipe its
    // description, reset its limit, drop its variant filter or bring it back from ARCHIVED.
    const { api, writes, reads, generations } = fakeApi({
      generated: [suggestionsFor({ description: true })],
      saved: {
        id: 42,
        name: "Coverage",
        description: "What the brewing features cover",
        spaceKey: "DEMO",
        sharedLevel: "SHARED_EDIT",
        status: "ARCHIVED",
        json: JSON.stringify({ columns: [{ columnIndex: 0 }], query: "key ~ 'FN-%'", limit: 25, variants: [8962] }),
      },
    })

    const report = await saveTraceabilityMatrix({
      ...context(api),
      name: "Coverage",
      columns: [{ type: "DESCRIPTION" }],
      matrixId: 42,
    })

    expect(report.saved).toBe(true)
    // The stored matrix is read BEFORE anything is validated, so a bad id costs no probe.
    expect(reads).toEqual([42])
    expect(writes[0].payload).toMatchObject({
      description: "What the brewing features cover",
      sharedLevel: "SHARED_EDIT",
      status: "ARCHIVED",
    })
    const definition = JSON.parse(writes[0].payload.json)
    expect(definition.limit).toBe(25)
    expect(definition.variants).toEqual([8962])
    // And the probe used the same variant filter the saved matrix will, or the column would have been
    // validated against data the matrix never shows.
    expect(generations[0].matrix.variants).toEqual([8962])
    // Silently keeping values is not enough — the caller has to know what it did not restate.
    expect(report.warnings[0]).toContain("did not restate")
    expect(report.warnings[0]).toContain("shared_level")
  })

  it("changes only what an update actually states", async () => {
    const { api, writes } = fakeApi({
      generated: [suggestionsFor({ description: true })],
      saved: { id: 42, sharedLevel: "SHARED_EDIT", status: "ARCHIVED", json: JSON.stringify({ columns: [], limit: 25 }) },
    })

    const report = await saveTraceabilityMatrix({
      ...context(api),
      name: "Coverage",
      columns: [{ type: "DESCRIPTION" }],
      matrixId: 42,
      sharedLevel: "NONE",
      status: "ACTIVE",
      limit: 500,
    })

    expect(writes[0].payload).toMatchObject({ sharedLevel: "NONE", status: "ACTIVE" })
    expect(JSON.parse(writes[0].payload.json).limit).toBe(500)
    expect(report.warnings).toEqual([])
  })

  it("still creates a matrix with the plain defaults when there is nothing to preserve", async () => {
    const { api, writes, reads } = fakeApi({ generated: [suggestionsFor({ description: true })] })
    const report = await saveTraceabilityMatrix({ ...context(api), name: "New", columns: [{ type: "DESCRIPTION" }] })
    // A create reads nothing: there is no stored matrix to preserve anything from.
    expect(reads).toEqual([])
    expect(writes[0].payload).toMatchObject({ sharedLevel: "NONE", status: "ACTIVE" })
    expect(report.warnings).toEqual([])
  })

  it("refuses a blank name rather than storing a matrix nobody can find", async () => {
    // `min(1)` at the frontier accepts "   ", and the payload trims it to "".
    const { api, writes, generations } = fakeApi()
    const report = await saveTraceabilityMatrix({ ...context(api), name: "   ", columns: [{ type: "DESCRIPTION" }] })
    expect(report.saved).toBe(false)
    expect(report.problems[0]).toContain("needs a name")
    expect(writes).toEqual([])
    expect(generations).toEqual([])
  })

  it("saves the matrix with the caller's limit, not the discovery one", async () => {
    const { api, writes } = fakeApi({ generated: [suggestionsFor({ description: true })] })
    await saveTraceabilityMatrix({ ...context(api), name: "Small", columns: [{ type: "DESCRIPTION" }], limit: 25 })
    expect(JSON.parse(writes[0].payload.json).limit).toBe(25)

    const { api: other, writes: otherWrites } = fakeApi({ generated: [suggestionsFor({ description: true })] })
    await saveTraceabilityMatrix({ ...context(other), name: "Default", columns: [{ type: "DESCRIPTION" }] })
    expect(JSON.parse(otherWrites[0].payload.json).limit).toBe(DEFAULT_MATRIX_LIMIT)
  })

  it("reports a success with no id when the API answers with an empty body", async () => {
    const { api } = fakeApi({ generated: [suggestionsFor({ description: true })], created: {} })
    const report = await saveTraceabilityMatrix({ ...context(api), name: "Quiet", columns: [{ type: "DESCRIPTION" }] })
    expect(report.saved).toBe(true)
    expect(report.matrix_id ?? null).toBeNull()
    expect(formatSaveReport(report)).toContain("no id")
  })
})

// A REAL definition, copied verbatim out of the `json` column of a matrix that works in Requirement
// Yogi (space SCB, one property column and one Jira column). It is the reference for the exact shape
// this MCP must produce — notably `value: ""` rather than null on the valueless steps, and both index
// fields on every column. Anything that drifts from it renders differently from the product's own UI.
const REAL_STORED_DEFINITION = {
  limit: 200,
  query: "key ~ '%'",
  columns: [
    { step: { type: "FIRST_COLUMN", value: "" }, label: "Requirement", hidden: false, columnIndex: 0, parentColumnIndex: 0 },
    { step: { type: "PROPERTY", value: "Category" }, label: "Category", hidden: false, columnIndex: 1, parentColumnIndex: 0 },
    { step: { type: "JIRA", value: "" }, label: "All Jira relationships", hidden: false, columnIndex: 2, parentColumnIndex: 0 },
  ],
  spaceKey: "SCB",
  variants: [8962],
}

describe("the definition this MCP writes", () => {
  it("reproduces a definition Requirement Yogi itself stored, field for field", async () => {
    const { api, writes } = fakeApi({
      generated: [
        // Probe before column 1, then before column 2 (the property column now exists).
        { columnSuggestions: [{ propertySuggestions: [{ property: "Category" }], hasJiraLinks: true }] },
        { columnSuggestions: [{ propertySuggestions: [{ property: "Category" }], hasJiraLinks: true }, {}] },
      ],
    })

    const report = await saveTraceabilityMatrix({
      spaceKey: "SCB",
      query: "key ~ '%'",
      variants: [8962],
      api,
      name: "Category coverage",
      columns: [{ type: "PROPERTY", value: "Category" }, { type: "JIRA" }],
    })

    expect(report.saved).toBe(true)
    expect(JSON.parse(writes[0].payload.json)).toEqual(REAL_STORED_DEFINITION)
  })

  it("round-trips that definition through the read path", () => {
    // What we write must be what we can read back — including the labels and the empty values.
    const reading = readSavedMatrix(
      SavedMatrixSchema.parse({ id: 1, spaceKey: "SCB", query: "key ~ '%'", json: JSON.stringify(REAL_STORED_DEFINITION) })
    )
    expect(reading.definition).toEqual(REAL_STORED_DEFINITION)
    expect(reading.warnings).toEqual([])
  })
})

describe("toSavedMatrixPayload", () => {
  const definition: MatrixDefinition = {
    columns: [
      { label: "Requirement", step: { type: "FIRST_COLUMN", value: "" }, columnIndex: 0, parentColumnIndex: 0, hidden: false },
    ],
    query: "key ~ 'FN-%'",
    variants: null,
    limit: 200,
    spaceKey: "DEMO",
  }

  it("serialises the definition into a STRING, not a nested object", () => {
    // DTOSavedMatrix.json is a String on the backend; an object would be rejected or mis-read.
    const payload = toSavedMatrixPayload({ name: "Matrix", definition })
    expect(typeof payload.json).toBe("string")
    expect(JSON.parse(payload.json)).toEqual(definition)
  })

  it("duplicates the query from the SAME source, so root and definition cannot drift", () => {
    // The query is stored twice: at the root (what the saved-matrix list filters on) and inside
    // `json` (what actually runs). Out of sync, a matrix lists as one thing and executes another.
    const payload = toSavedMatrixPayload({ name: "Matrix", definition })
    expect(payload.query).toBe(definition.query)
    expect(JSON.parse(payload.json).query).toBe(payload.query)

    const other = toSavedMatrixPayload({ name: "Matrix", definition: { ...definition, query: "@Priority = 'High'" } })
    expect(other.query).toBe("@Priority = 'High'")
    expect(JSON.parse(other.json).query).toBe(other.query)
  })

  it("fills in the type, the space and the defaults", () => {
    const payload = toSavedMatrixPayload({ name: "  Matrix  ", definition })
    expect(payload).toMatchObject({
      name: "Matrix",
      type: "TRACEABILITY",
      spaceKey: "DEMO",
      sharedLevel: "NONE",
      // A saved query is live unless the caller says otherwise.
      status: "ACTIVE",
    })
    expect("id" in payload).toBe(false)
    expect("description" in payload).toBe(false)
  })

  it("takes the status from the request when one is given", () => {
    expect(toSavedMatrixPayload({ name: "M", definition, status: "ARCHIVED" }).status).toBe("ARCHIVED")
    expect(toSavedMatrixPayload({ name: "M", definition, status: "DELETED" }).status).toBe("DELETED")
  })

  it("keeps a description and a sharing level when given", () => {
    const payload = toSavedMatrixPayload({
      name: "Matrix",
      description: " Coverage of the brewing features ",
      definition,
      sharedLevel: "SHARED_VIEW",
      id: 9,
    })
    expect(payload).toMatchObject({
      description: "Coverage of the brewing features",
      sharedLevel: "SHARED_VIEW",
      id: 9,
    })
  })
})

describe("reading a saved matrix back", () => {
  const stored = (definition: unknown, extra: Record<string, unknown> = {}) =>
    SavedMatrixSchema.parse({ id: 3, name: "Matrix", spaceKey: "DEMO", json: JSON.stringify(definition), ...extra })

  it("parses the definition out of the json string", () => {
    const definition = { columns: [{ step: { type: "FIRST_COLUMN", value: "" }, columnIndex: 0, parentColumnIndex: 0 }], query: "q", limit: 200, spaceKey: "DEMO" }
    const reading = readSavedMatrix(stored(definition, { query: "q" }))
    expect(reading.definition).toMatchObject({ query: "q", spaceKey: "DEMO" })
    expect(reading.warnings).toEqual([])
  })

  it("flags a root query that has drifted from the definition's", () => {
    const reading = readSavedMatrix(stored({ columns: [{ columnIndex: 0 }], query: "runs" }, { query: "lists" }))
    expect(reading.warnings[0]).toContain("differs from the one inside its definition")
  })

  it("flags a definition that cannot render", () => {
    const reading = readSavedMatrix(stored({ columns: [], query: "q" }, { query: "q" }))
    expect(reading.warnings[0]).toContain("no columns")
  })

  it("reads a definition written by a newer version rather than rejecting it", () => {
    // Lenient on the way IN (unknown step types, extra fields) — a matrix authored in the RY UI or
    // by a later release must still be readable.
    const reading = readSavedMatrix(
      stored({ columns: [{ step: { type: "SOMETHING_NEW", value: "x" }, columnIndex: 0 }], query: "q", newField: 1 }, { query: "q" })
    )
    expect((reading.definition as { newField?: number }).newField).toBe(1)
  })

  it("turns an unusable json into a located RyResponseError", () => {
    expect(() => parseStoredDefinition(SavedMatrixSchema.parse({ id: 4 }))).toThrow(RyResponseError)
    expect(() => parseStoredDefinition(SavedMatrixSchema.parse({ id: 4, json: "{not json" }))).toThrow(/not valid JSON/)
    expect(() => parseStoredDefinition(SavedMatrixSchema.parse({ id: 4, json: '"a string"' }))).toThrow(
      /does not look like a matrix definition/
    )
  })
})

describe("listSavedMatrices", () => {
  it("summarises the page and passes the filters through", async () => {
    const { api, searches } = fakeApi({
      page: { items: [{ id: 1, name: "A", spaceKey: "DEMO", query: "q", json: "{}" }], total: 4 },
    })
    const list = await listSavedMatrices({
      filters: { owned: true, spaceKey: "DEMO", matrixType: "TRACEABILITY" },
      offset: 50,
      api,
    })
    expect(searches[0]).toMatchObject({ filters: { owned: true, spaceKey: "DEMO" }, offset: 50 })
    expect(list).toEqual({
      total: 4,
      returned: 1,
      offset: 50,
      matrices: [
        {
          id: 1,
          name: "A",
          description: undefined,
          space: "DEMO",
          type: undefined,
          status: undefined,
          shared_level: undefined,
          query: "q",
        },
      ],
    })
    // The stored definition is deliberately NOT in the list: one `json` blob per row is a wall of
    // text, and get_traceability_matrix exists for the one the caller cares about.
    expect(JSON.stringify(list)).not.toContain("json")
  })
})
