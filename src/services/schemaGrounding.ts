// Schema grounding — the data behind list_searchable_fields.
//
// Returns the REAL identifiers of a space so the LLM never invents field/property/relationship
// names when it writes an RQL query. This is business logic, not transport, which is why it lives
// here rather than in api/ryClient.ts: it decides WHAT to sample, HOW MUCH, and how to degrade
// when a category can't be resolved. It consumes the client; it never speaks HTTP itself.
//
// It is built ONLY from confirmed endpoints: relationship names from /relationships (standalone
// API), and everything else aggregated from a bounded sample of the space's own requirements via
// /rest/search (Confluence API). No metadata endpoint is assumed. Categories those two sources
// don't expose (dedicated variants/baselines/rules/jira-project endpoints are unconfirmed) are
// returned best-effort, with a caveat in `notes`.

import { z } from "zod"
import { ryClient, type RyClient } from "../api/ryClient.js"
import { isExternalProperty, propertyLabel, relationshipName, type Requirement } from "../api/dto.js"

// Only the two endpoints this service needs — narrow enough that a test can stand in a fake
// without a network, which is what makes the sampling loop below testable at all.
export type SchemaGroundingApi = Pick<RyClient, "listAllRelationships" | "searchRequirements">

export type SearchableFieldsOptions = {
  spaceKey: string
  applicationId?: number
  instanceBaseUrl?: string
  api?: SchemaGroundingApi
}

// Cap how many requirements we inspect: distinct identifiers converge fast, and this tool must
// stay cheap enough to call speculatively before searching.
const SCHEMA_SAMPLE_MAX = 1000

// `key ~ '%'` matches every requirement (each has a key), which is exactly the sample we want.
const SAMPLE_QUERY = "key ~ '%'"

// Declared as a schema rather than a bare type so list_searchable_fields can publish it as its
// MCP outputSchema without restating the shape (and drifting from it).
export const SearchableFieldsSchema = z.object({
  space: z.string().describe("The Confluence space these identifiers belong to"),
  properties: z.array(z.string()).describe("Requirement property names — use as @Name"),
  external_properties: z.array(z.string()).describe("Typed/external property names — use as ext@Name"),
  relationships: z.array(z.string()).describe("Relationship names — use as from@/to@/parent@/child@/jira@Name"),
  variants: z.array(z.string()).describe("Variant names (best-effort, see notes)"),
  baselines: z.array(z.string()).describe("Baseline names (best-effort, see notes)"),
  rules: z.array(z.string()).describe("Rule labels for ruleStatus@ conditions (best-effort, see notes)"),
  jira_projects: z.array(z.string()).describe("Jira project keys seen on the sampled requirements (best-effort)"),
  sampled: z.number().int().describe("How many requirements were inspected to build these lists"),
  notes: z.array(z.string()).describe("Caveats about what could and could not be resolved"),
})

export type SearchableFields = z.infer<typeof SearchableFieldsSchema>

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

// Variant, baseline, jira project and rule identifiers are read from fields the DTO doesn't
// declare (the API may or may not expose them), so they stay defensive on purpose — unlike
// properties and relationships, which now come typed from src/api/dto.ts.
function collectNamed(value: unknown, into: Set<string>, ...names: string[]): void {
  const record = asRecord(value)
  if (record) {
    for (const name of names) {
      const candidate = record[name]
      if (typeof candidate === "string" && candidate.trim()) {
        into.add(candidate.trim())
        return
      }
    }
  } else if (typeof value === "string" && value.trim()) {
    into.add(value.trim())
  }
}

export function collectProperties(requirement: Requirement, plain: Set<string>, external: Set<string>): void {
  for (const property of requirement.properties ?? []) {
    const label = propertyLabel(property)
    if (!label) continue
    ;(isExternalProperty(property) ? external : plain).add(label)
  }
}

// Scan a set of candidate array fields on the requirement, reading a named identifier out of each
// entry. Jira projects and rules differ only in which fields hold the list and which keys name the
// value, so they share this one loop rather than two copy-pasted ones.
function collectFromFields(
  requirement: Requirement,
  fields: string[],
  into: Set<string>,
  ...names: string[]
): void {
  for (const field of fields) {
    const list = (requirement as Record<string, unknown>)[field]
    if (!Array.isArray(list)) continue
    for (const entry of list) collectNamed(entry, into, ...names)
  }
}

export async function listSearchableFields(options: SearchableFieldsOptions): Promise<SearchableFields> {
  const { spaceKey, applicationId, instanceBaseUrl, api = ryClient() } = options
  const notes: string[] = []
  const properties = new Set<string>()
  const external = new Set<string>()
  const variants = new Set<string>()
  const baselines = new Set<string>()
  const rules = new Set<string>()
  const jiraProjects = new Set<string>()
  const relationships = new Set<string>()
  let sampled = 0

  // Relationship names come from a different API (standalone) with its own auth and host, so kick
  // that request off NOW and let it run alongside the requirement sampling below (Confluence API)
  // instead of blocking on it first — this tool is called speculatively before every search, so
  // the saved round trip matters. Folded into a never-rejecting result up front so the in-flight
  // promise can't raise an unhandled rejection while the sampling loop awaits, and so a failure
  // there (e.g. applicationId required) still doesn't sink the property discovery.
  const relationshipsResult = api.listAllRelationships(applicationId).then(
    (list) => ({ ok: true as const, list }),
    (error: unknown) => ({ ok: false as const, error })
  )

  let offset = 0
  for (;;) {
    const page = await api.searchRequirements({ query: SAMPLE_QUERY, spaceKey, offset, instanceBaseUrl })
    const results = page.results ?? []
    for (const requirement of results) {
      sampled++
      collectProperties(requirement, properties, external)
      const record = requirement as Record<string, unknown>
      collectNamed(record.variant ?? record.variantName, variants, "name", "label")
      collectNamed(record.baseline ?? record.baselineName, baselines, "name", "label")
      collectFromFields(requirement, ["jiraLinks", "links", "jira", "jiraIssues"], jiraProjects, "projectKey", "project", "projectName")
      collectFromFields(requirement, ["ruleStatuses", "rules", "ruleResults"], rules, "rule", "ruleName", "label", "name")
    }
    const hasNext = page.hasNext === true
    offset += results.length
    if (!hasNext || results.length === 0 || sampled >= SCHEMA_SAMPLE_MAX) {
      if (hasNext && sampled >= SCHEMA_SAMPLE_MAX) {
        notes.push(
          `Property/variant lists sampled from the first ${sampled} requirements; rarely-used ones may be missing.`
        )
      }
      break
    }
  }

  // Now fold in the relationship names the concurrent request produced (or note why it couldn't).
  const relResult = await relationshipsResult
  if (relResult.ok) {
    for (const relationship of relResult.list) {
      const name = relationshipName(relationship)
      if (name) relationships.add(name)
    }
  } else {
    notes.push(
      `Could not list relationships (${(relResult.error as Error).message}). Call list_relationships separately.`
    )
  }

  if (variants.size === 0) {
    notes.push("No variant names surfaced from the sample; every space still has a default variant 'Current'.")
  }
  if (baselines.size === 0 && rules.size === 0 && jiraProjects.size === 0) {
    notes.push(
      "Baselines, rule labels and Jira projects were not exposed by the sampled requirements — treat those as best-effort and confirm names with the user if needed."
    )
  }

  const sorted = (values: Set<string>) => [...values].sort()

  return {
    space: spaceKey,
    properties: sorted(properties),
    external_properties: sorted(external),
    relationships: sorted(relationships),
    variants: sorted(variants),
    baselines: sorted(baselines),
    rules: sorted(rules),
    jira_projects: sorted(jiraProjects),
    sampled,
    notes,
  }
}
