// Typed frontier with the Requirement Yogi APIs.
//
// Before this layer existed, every RY response travelled as `unknown` and the code compensated
// downstream with defensive casts (`asRecord`, `stringField`, `x as Record<string, unknown>`).
// That cost ~150 lines AND turned a backend shape change into a silent `undefined` deep inside a
// tool result. Parsing at the boundary trades that for one loud, located failure.
//
// Deliberately LENIENT, because these endpoints are still being confirmed against the real API:
//   - every schema is a LOOSE object, so unknown fields survive into the tool result instead of
//     being stripped (the LLM may well find them useful, and we don't want to gate on our own
//     knowledge of the DTO);
//   - anything we are not certain the API always sends is optional/nullish.
//
// Two failure granularities, on purpose:
//   - the ENVELOPE of a response (parseApi) is parsed strictly: a wholesale shape mismatch is a
//     real, loud RyResponseError rather than a silent undefined three frames later;
//   - a single ITEM inside a list (parseApiItems / lenientArray) is parsed on its own and DROPPED
//     if it doesn't match, keeping the rest — one odd row on an unconfirmed endpoint must not take
//     the whole list down (for /applications that would sink base-URL resolution and every
//     Confluence call after it). Dropped items are logged in dev.

import { z } from "zod"
import { RyResponseError } from "../errors.js"
import { logDev } from "../log.js"

// Known values of DTOApplication.type. Kept as a plain string in the schema on purpose: a new
// application type on the backend must not break discovery, it just won't match these constants.
export const APPLICATION_TYPE = {
  jira: "JIRA",
  confluence: "CONFLUENCE",
  standalone: "STANDALONE",
} as const

export const ACTIVE_STATUS = "ACTIVE"

// `id` is nullish like every other field here ON PURPOSE: these endpoints are unconfirmed, so a
// single item with a missing id must degrade (the resolvers skip it) rather than throw. A
// wrong-TYPED id (a string where a number is expected) fails this schema — but parseApiItems /
// lenientArray drop that one item and keep the rest, so the whole list still survives (Callers that
// need the id filter for a real number; the LLM still sees whatever the API sent).
export const OrganizationSchema = z.looseObject({
  id: z.number().int().nullish(),
  name: z.string().nullish(),
  displayName: z.string().nullish(),
})

export const ApplicationSchema = z.looseObject({
  id: z.number().int().nullish(),
  type: z.string().nullish(),
  status: z.string().nullish(),
  baseUrl: z.string().nullish(),
  name: z.string().nullish(),
})

export const RelationshipSchema = z.looseObject({
  id: z.number().int().nullish(),
  name: z.string().nullish(),
  label: z.string().nullish(),
})

// A requirement property arrives as { label | name | key, value, external? }. The three name
// spellings and the three "is external" spellings are the API's, not ours.
export const RequirementPropertySchema = z.looseObject({
  label: z.string().nullish(),
  name: z.string().nullish(),
  key: z.string().nullish(),
  value: z.unknown().nullish(),
  external: z.boolean().nullish(),
  isExternal: z.boolean().nullish(),
  ext: z.boolean().nullish(),
})

// A full DTORequirement is huge (storage data, recursive dependencies, rules…). This schema
// declares only the fields the linking use case needs; the rest still rides along thanks to the
// loose object, and gets dropped when the tool summarises the page.
export const RequirementSchema = z.looseObject({
  id: z.number().int().nullish(),
  key: z.string().nullish(),
  text: z.string().nullish(),
  applicationId: z.number().int().nullish(),
  containerId: z.number().int().nullish(),
  variantId: z.number().int().nullish(),
  status: z.string().nullish(),
  canonicalURL: z.string().nullish(),
  properties: z.array(RequirementPropertySchema).nullish(),
})

// DTOSearchResult<DTORequirement> from GET /rest/search. `results` is a LENIENT array: a single
// malformed requirement is dropped, not thrown, so it can't sink a 200-item page (and with it a
// speculative list_searchable_fields sample). The rest of the envelope is parsed strictly.
export const SearchPageSchema = z.looseObject({
  results: lenientArray(RequirementSchema, "GET /rest/search results").nullish(),
  offset: z.number().nullish(),
  limit: z.number().nullish(),
  total: z.number().nullish(),
  hasNext: z.boolean().nullish(),
  humanReadable: z.string().nullish(),
  messageBean: z.unknown().nullish(),
})

// DTOJiraBulkLinkResult from POST /rest/jira-bulk/links.
export const BulkLinkResultSchema = z.looseObject({
  linkedCount: z.number().nullish(),
  skippedCount: z.number().nullish(),
  unauthorizedCount: z.number().nullish(),
})

export type Organization = z.infer<typeof OrganizationSchema>
export type Application = z.infer<typeof ApplicationSchema>
export type Relationship = z.infer<typeof RelationshipSchema>
export type RequirementProperty = z.infer<typeof RequirementPropertySchema>
export type Requirement = z.infer<typeof RequirementSchema>
export type SearchPage = z.infer<typeof SearchPageSchema>
export type BulkLinkResult = z.infer<typeof BulkLinkResultSchema>

// Parses an API payload, turning a shape mismatch into a located RyResponseError rather than an
// `undefined` that only shows up three call frames later.
export function parseApi<Schema extends z.ZodType>(
  schema: Schema,
  payload: unknown,
  endpoint: string
): z.infer<Schema> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
    throw new RyResponseError(
      `Unexpected response shape from ${endpoint}${where}: ${issue?.message ?? "does not match the expected schema"}.`,
      endpoint
    )
  }
  return parsed.data
}

// Per-item parse of the item list of a paginated endpoint: each item is validated on its own, the
// ones that match are KEPT and the ones that don't are DROPPED (logged in dev) — never thrown. One
// odd row on a still-unconfirmed endpoint must not take the whole list down: for /applications that
// would sink base-URL resolution and every Confluence-side tool after it (see resolveInstanceBaseUrl).
export function parseApiItems<Schema extends z.ZodType>(
  schema: Schema,
  items: unknown[],
  endpoint: string
): z.infer<Schema>[] {
  return filterValidItems(schema, items, endpoint)
}

// The per-item filter behind both parseApiItems and lenientArray. Function declaration (hoisted) so
// lenientArray can be used by the schemas defined above it.
function filterValidItems<Schema extends z.ZodType>(
  schema: Schema,
  items: unknown[],
  label: string
): z.infer<Schema>[] {
  const kept: z.infer<Schema>[] = []
  items.forEach((item, index) => {
    const parsed = schema.safeParse(item)
    if (parsed.success) {
      kept.push(parsed.data)
      return
    }
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
    logDev(`${label}: dropped item ${index}${where} — ${issue?.message ?? "shape mismatch"}`)
  })
  if (kept.length !== items.length) logDev(`${label}: kept ${kept.length}/${items.length} item(s)`)
  return kept
}

// An array field whose ELEMENTS are parsed leniently (bad ones dropped and logged) instead of a
// single bad element failing the enclosing object. Used for the search results array.
function lenientArray<Schema extends z.ZodType>(schema: Schema, label: string) {
  return z.array(z.unknown()).transform((items) => filterValidItems(schema, items, label))
}

// --- Field accessors ------------------------------------------------------------------------
// The API spells some things more than one way; these resolve the spelling ONCE so callers never
// have to know about it.

// First spelling that carries a real value. Must NOT be a `??` chain: `??` only skips
// null/undefined, so a present-but-EMPTY spelling ("") would win over a later real one and the
// whole result would collapse to undefined — silently dropping a name schema grounding needs.
function firstNonEmpty(...values: (string | null | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

export function propertyLabel(property: RequirementProperty): string | undefined {
  return firstNonEmpty(property.label, property.name, property.key)
}

export function isExternalProperty(property: RequirementProperty): boolean {
  return property.external === true || property.isExternal === true || property.ext === true
}

export function relationshipName(relationship: Relationship): string | undefined {
  return firstNonEmpty(relationship.name, relationship.label)
}

export function isActiveConfluenceApplication(application: Application): boolean {
  return application.type === APPLICATION_TYPE.confluence && application.status === ACTIVE_STATUS
}
