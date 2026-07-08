// HTTP client for the Requirement Yogi APIs.
//
// Configuration:
//   RY_ENV                    "dev" or "prod" (default "prod"). Baked into the bundle at build
//                             time (esbuild --define, see build:dev / build:prod); "dev" forces
//                             the local dev hosts and ignores RY_DATA_RESIDENCY. Can still be
//                             overridden by a real env var when running the tsc `dist/` build.
//   RY_DATA_RESIDENCY         "EU" or "US" — we map it to the right API hosts internally
//                             (prod only). From the MCP server environment (mcpServers config).
//   RY_PERSONAL_ACCESS_TOKEN  personal access token. From the MCP server environment.
//
// RY exposes several APIs; the host AND the auth scheme depend on the call:
//   - the standalone API (new)     → applications (GET /applications) and relationships
//                                    (GET /relationships); auth = Authorization: Bearer <token>
//   - the Confluence REST API (old)→ requirement search (GET /rest/search) and the Jira link
//                                    service (POST /rest/jira-bulk/links); auth = two headers,
//                                    X-Api-Key: <token> and X-Base-Url: <instance base URL>.
//                                    The instance base URL comes from GET /applications on the
//                                    standalone API (auto-resolved and cached below).

// Prod hosts, selected by data residency. The `/api` suffix is part of the standalone base
// (the paths — /applications, /relationships… — don't carry it); the Confluence paths already
// carry their own /rest prefix, so its base is the bare host.
const API_HOSTS = {
  EU: {
    confluence: "https://confluence.requirementyogi.com",
    standalone: "https://api.requirementyogi.com/api",
  },
  US: {
    confluence: "https://confluence.us.requirementyogi.com",
    standalone: "https://api.us.requirementyogi.com/api",
  },
} as const

// Dev hosts (RY_ENV=dev): standalone served locally, Confluence on the shared dev instance.
// Same base convention as prod — standalone keeps the /api suffix, Confluence stays bare.
const DEV_HOSTS = {
  confluence: "https://https4028.websites.requirementyogi.com",
  standalone: "http://localhost:8082/api",
} as const

type ApiHosts = { confluence: string; standalone: string }

type DataResidency = keyof typeof API_HOSTS

// RY_ENV picks the environment; anything other than "dev" (including unset) means prod.
function isDevEnv(): boolean {
  return process.env.RY_ENV?.trim().toLowerCase() === "dev"
}

// Dev forces the local hosts and ignores RY_DATA_RESIDENCY; prod maps residency to hosts.
function apiHosts(): ApiHosts {
  return isDevEnv() ? DEV_HOSTS : API_HOSTS[dataResidency()]
}

const SEARCH_PAGE_SIZE = 200
const RELATIONSHIPS_PAGE_SIZE = 100

// Mirrors DTORequirementSelection: which requirements a bulk operation applies to.
export type RequirementSelection = {
  query?: string
  containerId: number
  variantId: number
  selectedRequirementIds: number[]
  excludedRequirementIds: number[]
  selectAll: boolean
}

export type JiraBulkLink = {
  selection: RequirementSelection
  jiraApplicationId: number
  issueIds: number[]
  relationshipId: number
}

function dataResidency(): DataResidency {
  const raw = process.env.RY_DATA_RESIDENCY?.trim().toUpperCase()
  if (raw !== "EU" && raw !== "US") {
    throw new Error(
      `RY_DATA_RESIDENCY must be "EU" or "US" (got ${raw ? `"${raw}"` : "nothing"}). Set it in the MCP server environment (env section of the mcpServers config).`
    )
  }
  return raw
}

function accessToken(): string {
  const token = process.env.RY_PERSONAL_ACCESS_TOKEN
  if (!token) {
    throw new Error(
      "RY_PERSONAL_ACCESS_TOKEN is not set. Add your Requirement Yogi personal access token to the MCP server environment (env section of the mcpServers config)."
    )
  }
  return token
}

async function doRequest(url: string, headers: Record<string, string>, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? "GET"
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(
      `RY API ${method} ${new URL(url).pathname} failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`
    )
  }
  if (response.status === 204) return null
  return response.json()
}

// New standalone API: Bearer token.
async function requestStandalone(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${apiHosts().standalone}${path}`
  return doRequest(url, { Authorization: `Bearer ${accessToken()}` }, init)
}

// Old Confluence REST API: X-Api-Key + X-Base-Url headers.
async function requestConfluence(path: string, init?: RequestInit, instanceBaseUrl?: string): Promise<unknown> {
  const url = `${apiHosts().confluence}${path}`
  const baseUrl = instanceBaseUrl ?? (await resolveInstanceBaseUrl())
  return doRequest(url, { "X-Api-Key": accessToken(), "X-Base-Url": baseUrl }, init)
}

// A paginated endpoint may return a bare array or wrap it in a well-known property.
function extractItems(page: unknown): unknown[] {
  if (Array.isArray(page)) return page
  if (page && typeof page === "object") {
    const record = page as Record<string, unknown>
    for (const property of ["results", "relationships", "applications", "items", "values"]) {
      if (Array.isArray(record[property])) return record[property] as unknown[]
    }
  }
  return []
}

function pageTotal(page: unknown): number | undefined {
  if (page && typeof page === "object" && typeof (page as Record<string, unknown>).total === "number") {
    return (page as Record<string, unknown>).total as number
  }
  return undefined
}

// Standalone API pagination: responses are { items, offset, limit, total }. The server may
// cap the requested limit (default is 20), so trust `total` to know when to stop rather
// than page fullness.
async function fetchAllStandalonePages(path: string, pageSize: number): Promise<unknown[]> {
  const all: unknown[] = []
  let offset = 0
  for (;;) {
    const separator = path.includes("?") ? "&" : "?"
    const page = await requestStandalone(`${path}${separator}offset=${offset}&limit=${pageSize}`)
    const items = extractItems(page)
    all.push(...items)
    const total = pageTotal(page)
    const done =
      items.length === 0 || (total !== undefined ? all.length >= total : items.length < pageSize)
    if (done) break
    offset += items.length
  }
  return all
}

// GET /organizations on the standalone API: the organizations the token can see
// (each has an id, a name and a displayName).
// TODO: confirm the endpoint path and response shape against the real API.
export async function listOrganizations(): Promise<unknown[]> {
  return fetchAllStandalonePages(`/organizations`, 100)
}

function organizationIdOf(organization: unknown): number | undefined {
  if (!organization || typeof organization !== "object") return undefined
  const id = (organization as Record<string, unknown>).id
  return typeof id === "number" ? id : undefined
}

let cachedOrganizationId: number | undefined

// A token may span several organizations. With a single one, resolve it once and cache
// it; with several, the user must choose (the organization ID is visible in the
// Requirement Yogi admin panel in Confluence or Jira).
async function resolveOrganizationId(): Promise<number | undefined> {
  if (cachedOrganizationId !== undefined) return cachedOrganizationId
  const organizations = await listOrganizations()
  const ids = [...new Set(organizations.map(organizationIdOf).filter((id): id is number => id !== undefined))]
  if (ids.length === 0) return undefined // token presumably scoped; let /applications decide
  if (ids.length === 1) {
    cachedOrganizationId = ids[0]
    return cachedOrganizationId
  }
  throw new Error(
    `Several organizations are accessible (ids: ${ids.join(", ")}). Call list_organizations, ask the user which organization to use (the organization ID is visible in the Requirement Yogi admin panel in Confluence or Jira), and pass organization_id explicitly.`
  )
}

// GET /applications on the standalone API: the instances linked to Requirement Yogi.
// Each item carries an id (→ jiraApplicationId for JIRA items), a type
// ("JIRA" | "CONFLUENCE" | "STANDALONE"), a status ("ACTIVE"…) and, for Jira/Confluence
// instances, a baseUrl (→ X-Base-Url for Confluence ones). The organization is
// auto-resolved when not provided.
export async function listApplications(organizationId?: number): Promise<unknown[]> {
  const resolvedOrganizationId = organizationId ?? (await resolveOrganizationId())
  const path =
    resolvedOrganizationId !== undefined
      ? `/applications?organizationId=${resolvedOrganizationId}`
      : `/applications`
  return fetchAllStandalonePages(path, 100)
}

function applicationBaseUrl(application: unknown): string | undefined {
  if (!application || typeof application !== "object") return undefined
  const baseUrl = (application as Record<string, unknown>).baseUrl
  return typeof baseUrl === "string" ? baseUrl : undefined
}

// /applications can list several Confluence AND several Jira instances (plus the
// standalone app itself); only the active Confluence ones are candidates for X-Base-Url.
function isActiveConfluenceApplication(application: unknown): boolean {
  if (!application || typeof application !== "object") return false
  const record = application as Record<string, unknown>
  return record.type === "CONFLUENCE" && record.status === "ACTIVE"
}

let cachedInstanceBaseUrl: string | undefined

// The Confluence API needs the Confluence instance base URL in X-Base-Url. When the token
// sees a single active Confluence instance, resolve it once via GET /applications and cache
// it; otherwise the user must choose the instance and the caller passes its base URL.
async function resolveInstanceBaseUrl(): Promise<string> {
  if (cachedInstanceBaseUrl) return cachedInstanceBaseUrl
  const applications = await listApplications()
  const baseUrls = [
    ...new Set(
      applications
        .filter(isActiveConfluenceApplication)
        .map(applicationBaseUrl)
        .filter((url): url is string => !!url)
    ),
  ]
  if (baseUrls.length === 1) {
    cachedInstanceBaseUrl = baseUrls[0]
    return cachedInstanceBaseUrl
  }
  throw new Error(
    baseUrls.length === 0
      ? "Could not resolve a Confluence instance base URL from GET /applications. Call list_applications, ask the user which Confluence instance to use, and pass its base_url explicitly."
      : `Several Confluence instances are connected (${baseUrls.join(", ")}). Ask the user which instance to use and pass its base_url explicitly.`
  )
}

export type SearchOptions = {
  query: string
  spaceKey?: string
  offset?: number
  instanceBaseUrl?: string
}

// GET /rest/search on the Confluence API. The query uses the RY custom search
// syntax (see searchSyntax.ts, surfaced to the LLM in the tool description).
// The response is a DTOSearchResult<DTORequirement>: { results, offset, limit, total,
// hasNext, humanReadable?, messageBean }. Links/dependencies are not needed for the
// linking use case, so their default-true flags are turned off to slim the payload.
export async function searchRequirements(options: SearchOptions): Promise<unknown> {
  const params = new URLSearchParams({
    query: options.query,
    limit: String(SEARCH_PAGE_SIZE),
    offset: String(options.offset ?? 0),
    withLinks: "false",
    withOriginalLinks: "false",
    withDependencies: "false",
  })
  if (options.spaceKey) params.set("spaceKey", options.spaceKey)
  return requestConfluence(`/rest/search?${params}`, undefined, options.instanceBaseUrl)
}

// GET /relationships on the standalone API, paginated with offset/limit.
// applicationId is required unless the token is already scoped to a single application.
export async function listAllRelationships(applicationId?: number): Promise<unknown[]> {
  const path =
    applicationId !== undefined ? `/relationships?applicationId=${applicationId}` : `/relationships`
  return fetchAllStandalonePages(path, RELATIONSHIPS_PAGE_SIZE)
}

// --- Schema grounding: list_searchable_fields -------------------------------------------------
//
// Returns the REAL identifiers of a space so the LLM never invents field/property/relationship
// names. It is built ONLY from confirmed endpoints: the relationship names from /relationships
// (standalone API), and everything else aggregated from a bounded sample of the space's own
// requirements via /rest/search (Confluence API). No metadata endpoint is assumed. Categories we
// cannot yet resolve from those two sources (dedicated variants/baselines/rules/jira-project
// endpoints are unconfirmed) are returned as whatever the sampled requirements expose, best-effort.

// Cap how many requirements we inspect: distinct identifiers converge fast, and this tool must
// stay cheap enough to call speculatively before searching.
const SCHEMA_SAMPLE_MAX = 1000

export type SearchableFields = {
  space: string
  properties: string[]
  external_properties: string[]
  relationships: string[]
  variants: string[]
  baselines: string[]
  rules: string[]
  jira_projects: string[]
  sampled: number
  notes: string[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

// A requirement property may be shaped as { label | name, value, external?, type? }. Collect its
// identifier; classify as external (ext@) when the entry advertises it, otherwise plain (@).
function collectProperties(req: Record<string, unknown>, plain: Set<string>, external: Set<string>): void {
  const properties = req.properties
  if (!Array.isArray(properties)) return
  for (const entry of properties) {
    const record = asRecord(entry)
    if (!record) continue
    const label = stringField(record, "label", "name", "key")
    if (!label) continue
    const isExternal = record.external === true || record.isExternal === true || record.ext === true
    ;(isExternal ? external : plain).add(label)
  }
}

// Variant, baseline, jira project and rule identifiers are extracted defensively — the DTO may or
// may not expose them, and we never fail the tool if a shape is missing.
function collectNamed(value: unknown, into: Set<string>, ...names: string[]): void {
  const record = asRecord(value)
  if (record) {
    const name = stringField(record, ...names)
    if (name) into.add(name)
  } else if (typeof value === "string" && value.trim()) {
    into.add(value.trim())
  }
}

function collectJiraProjects(req: Record<string, unknown>, into: Set<string>): void {
  for (const field of ["jiraLinks", "links", "jira", "jiraIssues"]) {
    const list = req[field]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const record = asRecord(entry)
      if (record) collectNamed(record, into, "projectKey", "project", "projectName")
    }
  }
}

function collectRules(req: Record<string, unknown>, into: Set<string>): void {
  for (const field of ["ruleStatuses", "rules", "ruleResults"]) {
    const list = req[field]
    if (!Array.isArray(list)) continue
    for (const entry of list) collectNamed(entry, into, "rule", "ruleName", "label", "name")
  }
}

// Names of every relationship the token can see; these enable from@/to@/parent@/child@/jira@<name>.
async function relationshipNames(applicationId?: number): Promise<string[]> {
  const relationships = await listAllRelationships(applicationId)
  const names = new Set<string>()
  for (const relationship of relationships) {
    const record = asRecord(relationship)
    if (record) collectNamed(record, names, "name", "label")
  }
  return [...names]
}

export async function listSearchableFields(
  spaceKey: string,
  applicationId?: number,
  instanceBaseUrl?: string
): Promise<SearchableFields> {
  const notes: string[] = []
  const properties = new Set<string>()
  const external = new Set<string>()
  const variants = new Set<string>()
  const baselines = new Set<string>()
  const rules = new Set<string>()
  const jiraProjects = new Set<string>()
  let relationships: string[] = []
  let sampled = 0

  // Relationship names come from a different API (standalone) with its own auth — keep it isolated
  // so a failure there (e.g. applicationId required) doesn't sink the property discovery.
  try {
    relationships = await relationshipNames(applicationId)
  } catch (error) {
    notes.push(`Could not list relationships (${(error as Error).message}). Call list_relationships separately.`)
  }

  // `key ~ '%'` matches every requirement (each has a key), which is exactly the sample we want;
  // spaceKey scopes it. Bounded by SCHEMA_SAMPLE_MAX so a big space stays cheap.
  let offset = 0
  for (;;) {
    const page = asRecord(await searchRequirements({ query: "key ~ '%'", spaceKey, offset, instanceBaseUrl }))
    const results = page && Array.isArray(page.results) ? (page.results as unknown[]) : []
    for (const result of results) {
      const req = asRecord(result)
      if (!req) continue
      sampled++
      collectProperties(req, properties, external)
      collectNamed(req.variant ?? req.variantName, variants, "name", "label")
      collectNamed(req.baseline ?? req.baselineName, baselines, "name", "label")
      collectJiraProjects(req, jiraProjects)
      collectRules(req, rules)
    }
    const hasNext = page?.hasNext === true
    offset += results.length
    if (!hasNext || results.length === 0 || sampled >= SCHEMA_SAMPLE_MAX) {
      if (hasNext && sampled >= SCHEMA_SAMPLE_MAX) {
        notes.push(`Property/variant lists sampled from the first ${sampled} requirements; rarely-used ones may be missing.`)
      }
      break
    }
  }

  if (variants.size === 0) {
    notes.push("No variant names surfaced from the sample; every space still has a default variant 'Current'.")
  }
  if (baselines.size === 0 && rules.size === 0 && jiraProjects.size === 0) {
    notes.push(
      "Baselines, rule labels and Jira projects were not exposed by the sampled requirements — treat those as best-effort and confirm names with the user if needed."
    )
  }

  return {
    space: spaceKey,
    properties: [...properties].sort(),
    external_properties: [...external].sort(),
    relationships: relationships.sort(),
    variants: [...variants].sort(),
    baselines: [...baselines].sort(),
    rules: [...rules].sort(),
    jira_projects: [...jiraProjects].sort(),
    sampled,
    notes,
  }
}

// POST /rest/jira-bulk/links on the Confluence API: links a selection of
// requirements to a set of Jira issues (numeric IDs) with one relationship.
export async function createJiraLinks(link: JiraBulkLink, instanceBaseUrl?: string): Promise<unknown> {
  return requestConfluence(
    `/rest/jira-bulk/links`,
    { method: "POST", body: JSON.stringify(link) },
    instanceBaseUrl
  )
}
