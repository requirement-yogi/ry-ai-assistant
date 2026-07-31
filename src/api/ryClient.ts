// HTTP client for the Requirement Yogi APIs. Transport only — what to call and how to authenticate
// it. Anything that decides WHAT to fetch or how to interpret it is a service (src/services/).
//
// It is a CLASS rather than a set of module functions because it owns two caches (the resolved
// organization and Confluence instance) and its configuration. As module-level `let`s those were
// process-global: a test could not get a clean client, and the second test to run inherited the
// first one's resolved instance. As instance fields they belong to a client you can just create
// another of.
//
// Production still uses a single shared instance — `ryClient()` below builds it lazily on first
// use, so a missing token surfaces as a RyConfigError on the first tool call rather than at import
// time (where nothing could catch it and the whole server would fail to start).
//
// Configuration:
// Every environment-specific value is BAKED at build time via esbuild --define (see
// scripts/build-bundle.mjs, driven by build:dev / build:prod). The only runtime MCP config is the
// access token (and RY_DATA_RESIDENCY in prod), so the MCP setup is identical for dev and prod.
//
//   RY_ENV                    "dev" or "prod" (default "prod"). Baked; selects the mode: prod uses
//                             the fixed baked values, dev uses the per-developer baked hosts below
//                             and ignores RY_DATA_RESIDENCY.
//   RY_DATA_RESIDENCY         "EU" or "US" — mapped to the right API hosts (prod only, RUNTIME:
//                             one prod bundle serves both). From the MCP server environment.
//   RY_PERSONAL_ACCESS_TOKEN  personal access token. RUNTIME, from the MCP server environment.
//   RY_DEV_CONFLUENCE_URL     dev only, BAKED from .env.dev — this developer's Confluence dev
//                             instance base URL (unique per developer).
//   RY_DEV_STANDALONE_URL     dev only, BAKED from .env.dev — this developer's standalone API base
//                             URL. Optional; defaults to the usual local http://localhost:8082/api.
//
// RY exposes several APIs; the host AND the auth scheme depend on the call:
//   - the standalone API (new)     → applications (GET /applications) and relationships
//                                    (GET /relationships); auth = Authorization: Bearer <token>
//   - the Confluence REST API (old)→ requirement search (GET /rest/search) and the Jira link
//                                    service (POST /rest/jira-bulk/links); auth = two headers,
//                                    X-Api-Key: <token> and X-Base-Url: <instance base URL>.
//                                    The instance base URL comes from GET /applications on the
//                                    standalone API (auto-resolved and cached per client).

import { isDevEnv, requireDevValue } from "../env.js"
import { logDev } from "../log.js"
import { RyAmbiguityError, RyApiError, RyConfigError, RyConnectionError, RyResponseError } from "../errors.js"
import {
  ApplicationSchema,
  BulkLinkResultSchema,
  OrganizationSchema,
  RelationshipSchema,
  SearchPageSchema,
  isActiveConfluenceApplication,
  parseApi,
  parseApiItems,
  type Application,
  type BulkLinkResult,
  type Organization,
  type Relationship,
  type SearchPage,
} from "./dto.js"
import {
  BACKEND_FILLED_ACCOUNT,
  SavedMatrixSchema,
  TraceabilityResultSchema,
  type MatrixDefinition,
  type SavedMatrix,
  type SavedMatrixFilters,
  type SavedMatrixPayload,
  type TraceabilityResult,
} from "./traceabilityDto.js"

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

export type ApiHosts = { confluence: string; standalone: string }

type DataResidency = keyof typeof API_HOSTS

// Dev hosts (RY_ENV=dev) are per-developer, so each developer's dev build bakes them from its
// .env.dev: the Confluence dev instance is that developer's own tunnel (required), the standalone
// API usually runs locally (optional, defaults to the standard local port). Same base convention
// as prod — standalone keeps the /api suffix, Confluence stays bare.
const DEV_STANDALONE_DEFAULT = "http://localhost:8082/api"

const SEARCH_PAGE_SIZE = 200
// One page size for every standalone-API endpoint (organizations, applications, relationships):
// they share the same { items, offset, limit, total } envelope, so they page identically.
const STANDALONE_PAGE_SIZE = 100
// Default page size for the saved-matrix list. Smaller than the search page: this is a browsable
// list of user-authored queries, and the LLM asks for more only if the user wants more.
const SAVED_MATRIX_PAGE_SIZE = 50

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

export type SearchOptions = {
  query: string
  spaceKey?: string
  offset?: number
  instanceBaseUrl?: string
}

export type MatrixGenerationOptions = {
  matrix: MatrixDefinition
  // Values for the variables the query uses, if any ({} when it uses none).
  variableValues?: Record<string, unknown>
  instanceBaseUrl?: string
}

export type SavedMatrixPageOptions = {
  filters: SavedMatrixFilters
  offset?: number
  limit?: number
  instanceBaseUrl?: string
}

export type SavedMatrixPage = {
  items: SavedMatrix[]
  total?: number
}

export type RyClientConfig = {
  hosts: ApiHosts
  token: string
}

function dataResidency(): DataResidency {
  const raw = process.env.RY_DATA_RESIDENCY?.trim().toUpperCase()
  if (raw !== "EU" && raw !== "US") {
    throw new RyConfigError(
      `RY_DATA_RESIDENCY must be "EU" or "US" (got ${raw ? `"${raw}"` : "nothing"}). Set it in the MCP server environment (env section of the mcpServers config).`
    )
  }
  return raw
}

function devHosts(): ApiHosts {
  return {
    confluence: requireDevValue(
      "RY_DEV_CONFLUENCE_URL",
      process.env.RY_DEV_CONFLUENCE_URL,
      "It is your personal Confluence dev instance base URL (e.g. https://<your-tunnel>.websites.requirementyogi.com)."
    ),
    standalone: process.env.RY_DEV_STANDALONE_URL?.trim() || DEV_STANDALONE_DEFAULT,
  }
}

// Reads the runtime configuration out of the environment. Throws RyConfigError when something the
// client cannot work without is missing, so the failure lands on the first tool call, described.
export function resolveConfig(): RyClientConfig {
  // Dev uses the per-developer hosts and ignores RY_DATA_RESIDENCY; prod maps residency to hosts.
  const hosts = isDevEnv() ? devHosts() : API_HOSTS[dataResidency()]
  const token = process.env.RY_PERSONAL_ACCESS_TOKEN
  if (!token) {
    throw new RyConfigError(
      "RY_PERSONAL_ACCESS_TOKEN is not set. Add your Requirement Yogi personal access token to the MCP server environment (env section of the mcpServers config)."
    )
  }
  return { hosts, token }
}

// Node's fetch rejects with a bare `TypeError: fetch failed` on any connection-level failure
// (DNS, refused, TLS, timeout); the actionable detail lives on error.cause. Surface it so callers
// see e.g. "connection failed for https://…/organizations: ECONNREFUSED" instead of "fetch failed".
function fetchFailureDetail(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause
  if (cause && typeof cause === "object") {
    return [(cause as { code?: string }).code, (cause as { message?: string }).message].filter(Boolean).join(" ")
  }
  return (error as Error).message
}

// A paginated endpoint may return a bare array or wrap it in a well-known property.
export function extractItems(page: unknown): unknown[] {
  if (Array.isArray(page)) return page
  if (page && typeof page === "object") {
    const record = page as Record<string, unknown>
    for (const property of ["results", "relationships", "applications", "organizations", "items", "values"]) {
      if (Array.isArray(record[property])) return record[property] as unknown[]
    }
  }
  return []
}

// The per-column pagination cursors of a matrix generation request.
//
// This array is NOT optional and NOT free-form in length: the backend reads
// `pagination.columnsPagination.get(column.columnIndex).getLastCellId()` for EVERY column of the
// definition, so it must hold one entry per column index. Sending `[]` (or anything shorter than the
// column count) is an IndexOutOfBoundsException on the server, which surfaces as a bare 500 —
// "An unexpected error has occurred", no `errors`, nothing pointing at the payload.
//
// It is sized off the highest columnIndex rather than the array length so it stays correct even for a
// definition whose columns are not in index order. `lastCellId` is null on a first page: there is no
// cursor to resume a column from yet.
export function columnsPagination(matrix: MatrixDefinition): { lastCellId: null }[] {
  const size = matrix.columns.reduce((highest, column) => Math.max(highest, column.columnIndex + 1), 0)
  return Array.from({ length: size }, () => ({ lastCellId: null }))
}

export function pageTotal(page: unknown): number | undefined {
  if (page && typeof page === "object" && typeof (page as Record<string, unknown>).total === "number") {
    return (page as Record<string, unknown>).total as number
  }
  return undefined
}

export class RyClient {
  // A token may span several organizations, and several Confluence instances may be connected.
  // When there is exactly one of either, resolve it once and remember it for this client.
  private cachedOrganizationId: number | undefined
  private cachedInstanceBaseUrl: string | undefined

  constructor(private readonly config: RyClientConfig) {}

  // --- Transport ------------------------------------------------------------------------------

  // Token headers (Authorization / X-Api-Key) are NEVER logged; X-Base-Url is (it's the Confluence
  // instance, not a secret, and it's exactly what you want when debugging instance routing).
  private async request(url: string, headers: Record<string, string>, init?: RequestInit): Promise<unknown> {
    const method = init?.method ?? "GET"
    const baseUrlHeader = headers["X-Base-Url"]
    logDev(`→ ${method} ${url}${baseUrlHeader ? ` (X-Base-Url: ${baseUrlHeader})` : ""}`)
    const startedAt = Date.now()

    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(init?.headers as Record<string, string> | undefined),
          ...headers,
        },
      })
    } catch (error) {
      const detail = fetchFailureDetail(error)
      logDev(`✗ ${method} ${url} — connection failed after ${Date.now() - startedAt}ms: ${detail}`)
      throw new RyConnectionError(
        `Connection failed for ${url}: ${detail || "fetch failed"} (dev builds target http://localhost:8082).`,
        url
      )
    }

    const path = new URL(url).pathname
    logDev(`← ${response.status} ${response.statusText} ${method} ${path} (${Date.now() - startedAt}ms)`)

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      logDev(`  body: ${body || "(empty)"}`)
      // The body is relayed VERBATIM: for a malformed RQL query the RY API answers 400 with
      // "Syntax error at position N: ...", which is exactly what lets the model self-correct.
      throw new RyApiError(
        `RY API ${method} ${path} failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
        response.status,
        method,
        path,
        body
      )
    }

    if (response.status === 204) return null
    // A 2xx can still carry an EMPTY body (e.g. the link service answering a success with nothing).
    // response.json() throws a raw SyntaxError on "", so read the text: empty → null (the caller
    // decides what an empty success means — see createJiraLinks), a non-empty body that isn't JSON
    // becomes a located RyResponseError rather than an opaque SyntaxError.
    const body = await response.text()
    if (!body.trim()) return null
    try {
      return JSON.parse(body)
    } catch {
      throw new RyResponseError(
        `RY API ${method} ${path} returned a body that is not valid JSON: ${body.slice(0, 200)}`,
        path
      )
    }
  }

  // New standalone API: Bearer token.
  private requestStandalone(path: string, init?: RequestInit): Promise<unknown> {
    return this.request(`${this.config.hosts.standalone}${path}`, { Authorization: `Bearer ${this.config.token}` }, init)
  }

  // Old Confluence REST API: X-Api-Key + X-Base-Url headers.
  private async requestConfluence(path: string, init?: RequestInit, instanceBaseUrl?: string): Promise<unknown> {
    const baseUrl = instanceBaseUrl ?? (await this.resolveInstanceBaseUrl())
    return this.request(
      `${this.config.hosts.confluence}${path}`,
      { "X-Api-Key": this.config.token, "X-Base-Url": baseUrl },
      init
    )
  }

  // Standalone API pagination: responses are { items, offset, limit, total }. The server may cap
  // the requested limit (default is 20), so trust `total` to know when to stop rather than page
  // fullness.
  private async fetchAllStandalonePages(path: string, pageSize: number): Promise<unknown[]> {
    const all: unknown[] = []
    let offset = 0
    for (;;) {
      const separator = path.includes("?") ? "&" : "?"
      const page = await this.requestStandalone(`${path}${separator}offset=${offset}&limit=${pageSize}`)
      const items = extractItems(page)
      all.push(...items)
      const total = pageTotal(page)
      const done = items.length === 0 || (total !== undefined ? all.length >= total : items.length < pageSize)
      if (done) break
      offset += items.length
    }
    return all
  }

  // --- Instance resolution --------------------------------------------------------------------

  private async resolveOrganizationId(): Promise<number | undefined> {
    if (this.cachedOrganizationId !== undefined) return this.cachedOrganizationId
    // GET /organizations is a best-effort convenience: it lets us scope /applications when the
    // token spans several organizations. Its path/shape is not yet confirmed against the real API,
    // so a failure here must NOT sink the single-organization happy path — fall through to an
    // unscoped /applications call (as if no organization were resolvable) rather than throwing.
    let organizations: Organization[]
    try {
      organizations = await this.listOrganizations()
    } catch {
      return undefined // let /applications decide without an organizationId scope
    }

    const ids = [
      ...new Set(
        organizations.map((organization) => organization.id).filter((id): id is number => typeof id === "number")
      ),
    ]
    if (ids.length === 0) return undefined // token presumably scoped; let /applications decide
    if (ids.length === 1) {
      this.cachedOrganizationId = ids[0]
      return this.cachedOrganizationId
    }
    throw new RyAmbiguityError(
      `Several organizations are accessible (ids: ${ids.join(", ")}). Call list_organizations to see them; the organization ID is also visible in the Requirement Yogi admin panel in Confluence or Jira.`
    )
  }

  // The Confluence API needs the Confluence instance base URL in X-Base-Url. When the token sees a
  // single active Confluence instance, resolve it once via GET /applications and cache it;
  // otherwise the user must choose the instance and the caller passes its base URL.
  private async resolveInstanceBaseUrl(): Promise<string> {
    if (this.cachedInstanceBaseUrl) return this.cachedInstanceBaseUrl

    // /applications can list several Confluence AND several Jira instances (plus the standalone
    // app itself); only the active Confluence ones are candidates for X-Base-Url.
    const applications = await this.listApplications()
    const baseUrls = [
      ...new Set(
        applications
          .filter(isActiveConfluenceApplication)
          .map((application) => application.baseUrl)
          .filter((url): url is string => !!url)
      ),
    ]

    if (baseUrls.length === 1) {
      this.cachedInstanceBaseUrl = baseUrls[0]
      return this.cachedInstanceBaseUrl
    }
    // Zero vs. several are different failures: with none connected there is nothing for the user
    // to pick, so it's a configuration problem (RyConfigError), not the "ask which one" ambiguity.
    if (baseUrls.length === 0) {
      throw new RyConfigError(
        "No active Confluence instance is connected to Requirement Yogi, so there is no base URL to authenticate the Confluence API with. Ask the user to connect their Confluence instance in the Requirement Yogi admin panel; list_applications shows what is currently connected."
      )
    }
    throw new RyAmbiguityError(`Several Confluence instances are connected (${baseUrls.join(", ")}).`)
  }

  // --- Endpoints ------------------------------------------------------------------------------

  // POST /telemetry on the standalone API: records which tool (feature) was invoked, so RY can see
  // which parts of the assistant get used. Best-effort and fire-and-forget: EVERY failure is
  // swallowed by the caller — telemetry must never block, delay, or break a tool call.
  async sendTelemetry(feature: string): Promise<void> {
    await this.requestStandalone(`/telemetry`, { method: "POST", body: JSON.stringify({ feature }) })
  }

  // GET /organizations on the standalone API: the organizations the token can see
  // (each has an id, a name and a displayName).
  // TODO: confirm the endpoint path and response shape against the real API.
  async listOrganizations(): Promise<Organization[]> {
    return parseApiItems(
      OrganizationSchema,
      await this.fetchAllStandalonePages(`/organizations`, STANDALONE_PAGE_SIZE),
      "GET /organizations"
    )
  }

  // GET /applications on the standalone API: the instances linked to Requirement Yogi. Each item
  // carries an id (→ jiraApplicationId for JIRA items), a type ("JIRA" | "CONFLUENCE" |
  // "STANDALONE"), a status ("ACTIVE"…) and, for Jira/Confluence instances, a baseUrl
  // (→ X-Base-Url for Confluence ones). The organization is auto-resolved when not provided.
  async listApplications(organizationId?: number): Promise<Application[]> {
    const resolved = organizationId ?? (await this.resolveOrganizationId())
    const path = resolved !== undefined ? `/applications?organizationId=${resolved}` : `/applications`
    return parseApiItems(
      ApplicationSchema,
      await this.fetchAllStandalonePages(path, STANDALONE_PAGE_SIZE),
      "GET /applications"
    )
  }

  // GET /relationships on the standalone API, paginated with offset/limit.
  // applicationId is required unless the token is already scoped to a single application.
  async listAllRelationships(applicationId?: number): Promise<Relationship[]> {
    const path = applicationId !== undefined ? `/relationships?applicationId=${applicationId}` : `/relationships`
    return parseApiItems(
      RelationshipSchema,
      await this.fetchAllStandalonePages(path, STANDALONE_PAGE_SIZE),
      "GET /relationships"
    )
  }

  // GET /rest/search on the Confluence API. The query uses the RY custom search syntax (the
  // reference the LLM gets is src/docs/search-syntax-prompt-v3.md). The response is a
  // DTOSearchResult<DTORequirement>. Links/dependencies are not needed for the linking use case,
  // so their default-true flags are turned off to slim the payload.
  async searchRequirements(options: SearchOptions): Promise<SearchPage> {
    const params = new URLSearchParams({
      query: options.query,
      limit: String(SEARCH_PAGE_SIZE),
      offset: String(options.offset ?? 0),
      withLinks: "false",
      withOriginalLinks: "false",
      withDependencies: "false",
    })
    if (options.spaceKey) params.set("spaceKey", options.spaceKey)
    return parseApi(
      SearchPageSchema,
      await this.requestConfluence(`/rest/search?${params}`, undefined, options.instanceBaseUrl),
      "GET /rest/search"
    )
  }

  // POST /rest/jira-bulk/links on the Confluence API: links a selection of requirements to a set
  // of Jira issues (numeric IDs) with one relationship.
  async createJiraLinks(link: JiraBulkLink, instanceBaseUrl?: string): Promise<BulkLinkResult> {
    const payload = await this.requestConfluence(
      `/rest/jira-bulk/links`,
      { method: "POST", body: JSON.stringify(link) },
      instanceBaseUrl
    )
    // A successful link can come back with no body (204, or 200 + empty → null from request()).
    // That's a success the server chose not to detail, NOT a shape error — return an empty result
    // rather than running null through parseApi, which would reject it and make createJiraLinkBatch
    // report a link that WAS created as a failure.
    if (payload === null) return {}
    return parseApi(BulkLinkResultSchema, payload, "POST /rest/jira-bulk/links")
  }

  // --- Traceability matrices (Confluence API) --------------------------------------------------

  // POST /rest/traceability/{spaceKey}: renders a matrix definition AND answers with
  // `columnSuggestions` — the only way to learn which columns a matrix can actually carry, since
  // there is no "list available columns" endpoint (the backend derives them from the requirements
  // really present in each column's cells). Requires READ permission on the space.
  //
  // `pagination.limit` is taken from the definition's own limit so a single knob drives both what
  // the server renders and how wide a sample the suggestions are derived from — services/
  // traceabilityMatrix.ts is what deliberately probes with the full 200 (see DISCOVERY_LIMIT).
  //
  // `pagination.columnsPagination` MUST have one entry per column index, or the server throws (see
  // columnsPagination above). It is derived from the definition here rather than passed in, so a
  // caller cannot get it out of step with the columns it is sending.
  async generateTraceabilityMatrix(options: MatrixGenerationOptions): Promise<TraceabilityResult> {
    const body = {
      traceabilityMatrix: options.matrix,
      pagination: {
        searchOffset: 0,
        limit: options.matrix.limit,
        columnsPagination: columnsPagination(options.matrix),
      },
      variableValues: options.variableValues ?? {},
    }
    // This endpoint reports a payload it cannot handle as a bare 500, with nothing to say what it
    // choked on — so trace the SHAPE of the definition (never the query text: it is the user's
    // content, see src/log.ts). Column types and the variant/variable fields are what you need to
    // compare against the request the RY UI itself sends.
    logDev(
      `matrix probe: ${options.matrix.columns.length} column(s) [${options.matrix.columns
        .map((column) => column.step.type)
        .join(", ")}], variants=${JSON.stringify(options.matrix.variants)}, limit=${options.matrix.limit}, variableValues=${
        Object.keys(body.variableValues).length
      } key(s)`
    )
    return parseApi(
      TraceabilityResultSchema,
      await this.requestConfluence(
        `/rest/traceability/${encodeURIComponent(options.matrix.spaceKey)}`,
        { method: "POST", body: JSON.stringify(body) },
        options.instanceBaseUrl
      ),
      "POST /rest/traceability/{spaceKey}"
    )
  }

  // The body of a saved-matrix write, for both the create and the update.
  //
  // Every write carries `ownerAccountId: BACKEND_FILLED_ACCOUNT` — the sentinel telling the backend
  // to resolve the owning account itself. It is injected HERE, in the transport, rather than in the
  // payload builder, so that it cannot be forgotten on one path and, more importantly, so that no
  // caller can put a real account id in its place: a client setting the owner would be reassigning
  // ownership. That is also why `ownerAccountId` is absent from SavedMatrixPayload — the only way it
  // reaches the wire is through this method.
  //
  // `id` rides along on an update (it is in the path AND the body). `status` does NOT come from here:
  // it is part of what the request asks for, so it comes from toSavedMatrixPayload.
  private savedMatrixBody(payload: SavedMatrixPayload, id?: number): string {
    return JSON.stringify({
      ...payload,
      ...(id !== undefined ? { id } : {}),
      ownerAccountId: BACKEND_FILLED_ACCOUNT,
    })
  }

  // POST /rest/saved-matrices: persists a saved query. The payload's `json` is the stringified
  // matrix definition (built by toSavedMatrixPayload, never here).
  async createSavedMatrix(payload: SavedMatrixPayload, instanceBaseUrl?: string): Promise<SavedMatrix> {
    const response = await this.requestConfluence(
      `/rest/saved-matrices`,
      { method: "POST", body: this.savedMatrixBody(payload) },
      instanceBaseUrl
    )
    // Like the link service, a write can answer with no body. That is a success the server chose
    // not to detail (we just won't know the new id), NOT a shape error.
    if (response === null) return {}
    return parseApi(SavedMatrixSchema, response, "POST /rest/saved-matrices")
  }

  // PUT /rest/saved-matrices/{id}: replaces an existing saved query.
  async updateSavedMatrix(id: number, payload: SavedMatrixPayload, instanceBaseUrl?: string): Promise<SavedMatrix> {
    const response = await this.requestConfluence(
      `/rest/saved-matrices/${id}`,
      { method: "PUT", body: this.savedMatrixBody(payload, id) },
      instanceBaseUrl
    )
    if (response === null) return {}
    return parseApi(SavedMatrixSchema, response, `PUT /rest/saved-matrices/{id}`)
  }

  // GET /rest/saved-matrices/{id}. The definition lives in the `json` string; parsing it is the
  // service's job (parseStoredDefinition), not the transport's.
  async getSavedMatrix(id: number, instanceBaseUrl?: string): Promise<SavedMatrix> {
    return parseApi(
      SavedMatrixSchema,
      await this.requestConfluence(`/rest/saved-matrices/${id}`, undefined, instanceBaseUrl),
      `GET /rest/saved-matrices/{id}`
    )
  }

  // POST /rest/saved-matrices/search?offset=&limit=, body = RYEntityFilters (`owned` is required).
  // ONE page, not every page: unlike the standalone endpoints this is a user-facing list the LLM
  // pages through on demand, and a space can hold a lot of saved matrices.
  async searchSavedMatrices(options: SavedMatrixPageOptions): Promise<SavedMatrixPage> {
    const params = new URLSearchParams({
      offset: String(options.offset ?? 0),
      limit: String(options.limit ?? SAVED_MATRIX_PAGE_SIZE),
    })
    const page = await this.requestConfluence(
      `/rest/saved-matrices/search?${params}`,
      { method: "POST", body: JSON.stringify(options.filters) },
      options.instanceBaseUrl
    )
    return {
      items: parseApiItems(SavedMatrixSchema, extractItems(page), "POST /rest/saved-matrices/search"),
      total: pageTotal(page),
    }
  }

  // DELETE /rest/saved-matrices/{id} → 204.
  async deleteSavedMatrix(id: number, instanceBaseUrl?: string): Promise<void> {
    await this.requestConfluence(`/rest/saved-matrices/${id}`, { method: "DELETE" }, instanceBaseUrl)
  }
}

// --- The shared instance ----------------------------------------------------------------------

let shared: RyClient | undefined

// The client every tool uses. Built on first call (not at import) so a missing token surfaces as a
// RyConfigError inside a tool call, where registry.ts turns it into a readable result. Not cached
// on failure, so fixing the environment doesn't require a restart in a long-lived process.
export function ryClient(): RyClient {
  if (!shared) shared = new RyClient(resolveConfig())
  return shared
}

// Drops the shared instance (and with it the resolved organization/instance caches). For tests.
export function resetRyClient(): void {
  shared = undefined
}

// Best-effort telemetry: EVERY failure (network, auth, missing token/residency) is swallowed here.
// It must never block, delay, or break a tool call.
export async function sendTelemetry(feature: string): Promise<void> {
  try {
    await ryClient().sendTelemetry(feature)
  } catch {
    // Intentionally ignored: telemetry is best-effort and must not surface to the user.
  }
}
