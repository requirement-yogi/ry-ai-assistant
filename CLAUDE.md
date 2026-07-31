# RY AI Assistant — MCP Server

## What this project does

An MCP (Model Context Protocol) server in TypeScript that gives an LLM client (Claude Desktop, Claude Code, Cursor…) the ability to place **Requirement Yogi macros** correctly into Confluence pages — in Atlassian Document Format (ADF).

It covers four use cases:
1. **Create a new Confluence page** from a structured requirements tree, with the RY macros placed in valid indexing contexts.
2. **Edit an existing Confluence page** by injecting RY macros in place, preserving the page's original format.
3. **Link requirements to Jira issues** through the Requirement Yogi API (finding/creating the Jira issues themselves is delegated to the Atlassian MCP).
4. **Create traceability-matrix saved queries** — a persisted `{ RQL query + column tree }` definition — with every column validated against the data before it is written.

This MCP is **not** a document-authoring tool. Its single value is owning the **Requirement Yogi rules** the LLM cannot know: where a macro may live in a page and what each context indexes (use cases 1–2), and which columns a traceability matrix can actually carry (use case 4). The intelligence is encoded in the server (deterministic `tree → ADF` rendering, deterministic suggestion → column translation), not in LLM instructions.

**Division of work:** the client LLM does the decomposition (breaking the request into a requirements tree) and decides what to key on an existing page; the MCP produces/modifies the ADF deterministically and validates the input (Zod). No server-side LLM calls. Publishing to Confluence is delegated to another available tool (e.g. the Atlassian MCP `createConfluencePage` / `updateConfluencePage`).

## Stack

- TypeScript + Node.js (ESM)
- `@modelcontextprotocol/sdk` for the MCP server
- `zod` v4 for schema validation
- Transport: stdio (standard MCP)

## Commands

```bash
npm run build        # full build: tsc → dist/ + both esbuild bundles into release/
npm run build:prod   # prod bundle only → release/ry-ai-assistant.mjs
npm run build:dev    # dev bundle only  → release/ry-ai-assistant-dev.mjs (dev mode baked in)
npm run compile      # tsc only → dist/ (also what `prepare`/`npm install` runs)
npm start            # run the compiled dist build (node dist/index.js)
npm test             # vitest (runs generate:docs first — the prompt/version modules are codegen)
```

The dev/prod split is **fully baked at build time** by `scripts/build-bundle.mjs` (esbuild `define`).
Every environment-specific value is hard-wired into its bundle, so the **runtime MCP config is
identical for dev and prod** — the only difference is which `.mjs` you point at:

- **prod** (`build:prod`) bakes `RY_ENV=prod`; the fixed prod values (Forge `environment_id`
  `126ed95b-…`, the constant `application_id`) live as constants in the source. `RY_DATA_RESIDENCY`
  stays a *runtime* choice because a single prod bundle serves both EU and US.
- **dev** (`build:dev`) bakes `RY_ENV=dev` plus that developer's unique values, read from a
  git-ignored **`.env.dev`** (copy `.env.dev.example`): `RY_DEV_FORGE_ENV_ID` (macro extension id,
  `src/tools/macro.ts`) and `RY_DEV_CONFLUENCE_URL` / `RY_DEV_STANDALONE_URL` (hosts, `devHosts()`
  in `src/api/ryClient.ts`).

`RY_ENV` / `isDevEnv()` / `requireDevValue()` live in `src/env.ts`. **esbuild `define` only
substitutes static `process.env.<NAME>` reads** — never a computed `process.env[name]` — so the
source reads each baked var literally and passes the value to `requireDevValue`. The dev bundle is
internal only and must not be referenced in the public README.

> Note: the bundler is **`esbuild-wasm`** (a WASM engine), not native `esbuild`, so `build:prod`/
> `build:dev`/`build` run identically on macOS and in the Linux sandbox from one shared
> `node_modules` — no per-platform native binary to reinstall. (`npm test`/vitest still pulls native
> esbuild transitively, so if you switch OS on a shared `node_modules`, re-run `npm install` before
> `npm test` — the build itself is unaffected.)

## Architecture

Four layers, each depending only on the one below it:

```
tools/      MCP adapters — schemas in, tool result out. No business logic, no catch blocks.
services/   business logic — what to sample, how to batch, how to report. Knows nothing of MCP.
api/        transport + typed frontier with the RY APIs. Knows nothing of tools or MCP.
prompts/    what the LLM reads. Markdown, no code.
```

```
src/
├── index.ts                  # MCP server (version from version.generated.ts), sets `instructions`, starts the update check, registers the 13 tools
├── version.generated.ts      # AUTO-GENERATED from package.json by embed-docs.mjs — the server's own version (single source: package.json)
├── errors.ts                 # the error taxonomy: RyConfigError / RyAmbiguityError / RyConnectionError / RyApiError / RyResponseError. Each carries the `guidance` (what to DO), written once here instead of per tool; formatToolFailure renders a failure for the LLM
├── log.ts                    # logDev — dev-only tracing to STDERR (STDOUT is the JSON-RPC stream). Never logs tokens or tool arguments
├── updateCheck.ts            # session-level update-check state: caches the GitHub check + emits the once-per-session "update available" banner (shared by updates.ts and registry.ts, no import cycle)
├── schemas/requirements.ts   # Zod schema + TypeScript types for the requirements tree
├── prompts/                  # EVERYTHING the LLM reads — markdown only, no logic
│   ├── tools/<tool name>.md  # one description per tool; the basename IS the tool name
│   ├── fragments/*.md        # shared blocks included by the above: jira-workflow, traceability-workflow, key-rules, indexing-contexts, search-syntax
│   ├── columns.md            # what each traceability column type MEANS, one `## STEP_TYPE` section each. Included in a tool description AND parsed into COLUMN_MEANINGS (the discovery `legend`) — see "The column glossary"
│   ├── descriptions.ts       # typed accessors (toolDescription, columnMeaning); a missing .md/section — or an orphan one — is a COMPILE error, in both directions
│   └── index.generated.ts    # AUTO-GENERATED from the .md by embed-docs.mjs (includes resolved, HTML comments stripped)
├── api/                      # transport only — no business logic
│   ├── dto.ts                # Zod schemas for every RY response + parseApi/parseApiItems. Deliberately lenient (loose objects, optional/nullish fields) since the endpoints are still being confirmed; a mismatch throws a located RyResponseError instead of a silent undefined
│   ├── traceabilityDto.ts    # the traceability-matrix contract: StepType (closed enum), Column/MatrixDefinition (what we BUILD, plain TS types), ColumnSuggestions + SavedMatrix (what we PARSE). columnSuggestions is a positional array, so it is NEVER parsed leniently — dropping an entry would shift every column index
│   ├── ryClient.ts           # RyClient class (caches = instance fields, so tests get a clean one) + the lazily-built shared `ryClient()`. In dev traces every call to STDERR; tokens are never logged. Connection failures surface error.cause (ECONNREFUSED/…) instead of a bare "fetch failed"
│   └── githubReleases.ts     # update check: GET the latest GitHub release + semver compare (best-effort, never throws)
├── services/                 # business logic, MCP-agnostic. Each takes an injectable `api` (a Pick<RyClient, …>) so it is testable without a network
│   ├── schemaGrounding.ts    # list_searchable_fields: bounded sampling of a space to return its REAL identifiers
│   ├── jiraLinking.ts        # MCP snake_case → DTORequirementSelection, batch execution with per-operation partial failure, report rendering
│   ├── matrixColumns.ts      # PURE: suggestions → candidate columns and one requested column → validated column. Owns the FROM/TO inversion, the all*-means-already-used rule and the column-tree invariants
│   └── traceabilityMatrix.ts # the two loops: the discovery probe (one round trip, suggestions for every column) and the column-by-column validation before persisting. Also toSavedMatrixPayload (json stringified, query kept in sync) and the read-back
└── tools/                    # MCP adapters only
    ├── toolNames.ts          # TOOL_NAMES + ToolName — single source of truth, own module so prompts/ can check against it
    ├── registry.ts           # THE choke point: registerTool wires description + telemetry + error handling + dev trace + update banner from the tool name alone. Also the shared `annotations` presets
    ├── updates.ts            # check_for_updates — ON-DEMAND "is this MCP up to date?" tool (the automatic once-per-session banner is injected by registry.ts, not this tool)
    ├── buildAdf.ts           # build_requirements_adf — tool wrapper (use case 1)
    ├── editPage.ts           # edit_page_requirements — analyze + reshape an existing page (use case 2)
    ├── jiraLinks.ts          # the 6 use-case-3 tools (organizations, applications, searchable-fields, search, relationships, links)
    ├── traceability.ts       # the 4 use-case-4 tools (discover columns, save matrix, get matrix, list matrices)
    ├── adfRender.ts          # shared deterministic renderers: tree→ADF, table, paragraph (the RY intelligence)
    └── macro.ts              # buildInlineExtension — shared RY macro node, single source of truth
docs/
    └── search-syntax-prompt-v3.md   # AUTHORITATIVE RQL syntax (from the backend ANTLR grammar + DSL eval); single source of truth
scripts/
    ├── embed-docs.mjs        # build-time codegen: src/prompts/**/*.md → src/prompts/index.generated.ts (imported by both tsc and esbuild builds)
    └── build-bundle.mjs      # esbuild bundler: bakes env-specific values via `define` (RY_ENV + dev's .env.dev) → release/*.mjs
tests/                        # unit tests, MIRRORING the src/ tree (tests/api/dto.test.ts ↔ src/api/dto.ts)
```

### Tests

Tests live under `tests/` at the repo root, mirroring `src/` (`tests/api/dto.test.ts` covers
`src/api/dto.ts`), and import the code under test with a `../../src/…` relative path. They are kept
out of `src/` on purpose: `tsconfig` builds only `src/` (`rootDir: src`), so nothing test-related
reaches `dist/`. Vitest's default glob picks up `tests/` with no extra config. When real
API-integration tests arrive (see "What remains to be done"), give them their own `tests/integration/`
so the fast unit suite stays network-free.

### Prompts are data, not code

Every string the LLM reads lives in `src/prompts/**/*.md` — never in a `.ts` file. `scripts/embed-docs.mjs`
(run by `generate:docs`, and automatically by `compile`/`bundle`/`test`) resolves `{{include:relative/path.md}}`
directives, strips HTML comments, and emits the git-ignored `src/prompts/index.generated.ts`. Codegen
(rather than a runtime `readFileSync`) is what lets the same import work in both the `tsc`→`dist/` build
and the self-contained esbuild `.mjs` bundle.

Consequences worth knowing:
- **Tuning a description is a markdown edit**, never a code change.
- A tool's description is resolved by `registerTool` **from its name** — tool files don't carry one.
  Adding a tool means adding it to `TOOL_NAMES` *and* creating `src/prompts/tools/<name>.md`; forgetting
  either is a compile error in `src/prompts/descriptions.ts` (both directions are checked).
- The RQL reference is still written **once** in `src/docs/search-syntax-prompt-v3.md` and pulled in by
  `fragments/search-syntax.md` — edit the markdown, never re-hardcode the syntax.

### Failures

Tool handlers **do not catch**. They throw, and `registry.ts` turns the error into an `isError` result
carrying the message plus the `guidance` of its class (see `src/errors.ts`). Every catch outside
`registry.ts` exists on purpose and is commented as such — each either keeps a best-effort concern from
surfacing or degrades gracefully rather than aborting the whole call: `sendTelemetry` (best-effort, must
never surface), the per-operation catch in `services/jiraLinking.ts` (a batch reports partial failures
instead of aborting), the relationships lookup in `services/schemaGrounding.ts` (a failure there still
returns the property names), the `/organizations` probe in `RyClient.resolveOrganizationId` (an
unconfirmed endpoint must not sink the single-organization happy path), and `preservedFields` in
`services/traceabilityMatrix.ts` (a stored definition that won't parse must not block the update that
would repair it — it only costs the definition-level fallbacks). Input validation (`safeParse`,
`JSON.parse`) still returns an `isError` result directly (via the shared `toolError` helper) — it is not
an exception path.

### outputSchema

Declared on the nine tools whose result is a small bounded record (`check_for_updates`, `list_organizations`,
`list_applications`, `list_searchable_fields`, `list_relationships`, `link_requirements_to_jira`,
`save_traceability_matrix`, `get_traceability_matrix`, `list_traceability_matrices`), which also return
`structuredContent`. NOT declared on `search_requirements`, `discover_matrix_columns` or the two ADF tools:
the spec asks a tool returning `structuredContent` to also serialise it into a text block for older clients,
and doing that with a 200-requirement page, a whole space's column vocabulary or a full ADF document would
send the payload twice for no gain.

## The MCP Tools

| Tool | Input | Output | Role |
|---|---|---|---|
| `check_for_updates` | — | update status + latest release notes | On-demand "am I up to date?" check. The once-per-session "update available" notice is surfaced automatically (banner prepended to the first tool result by `withTelemetry`), so this tool is a manual re-check, not the primary path |
| `build_requirements_adf` | `tree` (requirements JSON) | ADF body | Use case 1 — render a new page from scratch |
| `edit_page_requirements` | `page_adf`, `operations[]` | modified ADF body | Use case 2 — analyze an existing page and reshape it for indexing |
| `list_organizations` | — | organizations JSON (IDs + names) | Use case 3 — only when the token spans several organizations |
| `list_applications` | `organization_id?` | applications JSON (IDs + base URLs) | Use case 3 — discover the connected instances |
| `list_searchable_fields` | `space`, `application_id?`, `base_url?` | JSON of the space's real identifiers (properties, external, relationships, variants…) | Use case 3 — schema grounding: call before writing a query to avoid inventing field names |
| `search_requirements` | `query` (RQL), `space_key?`, `offset?`, `base_url?` | `{ total_count, returned, requirements[] }` (IDs + container/variant) | Use case 3 — discover the RY requirements; relays RQL parse errors verbatim for self-correction |
| `list_relationships` | `application_id?` | relationships JSON (with IDs) | Use case 3 — discover the available relationship types |
| `link_requirements_to_jira` | `links[]` (selection, jira_application_id, issue_ids, relationship_id), `base_url?` | creation report | Use case 3 — create the links via the RY jira-bulk service |
| `discover_matrix_columns` | `space`, `query` (RQL), `columns[]?`, `variants?`, `variable_values?`, `base_url?` | per column: the candidate child columns + notes | Use case 4 — THE discovery loop: one round trip per level of depth, because the column vocabulary is derived from the data |
| `save_traceability_matrix` | `space`, `name`, `query`, `columns[]`, `description?`, `variants?`, `limit?`, `shared_level?`, `matrix_id?` | save report (validated columns, warnings, or the problems and nothing written) | Use case 4 — validates every column against live suggestions, THEN persists the saved query (or refuses) |
| `get_traceability_matrix` | `matrix_id`, `base_url?` | the saved matrix + its definition parsed out of `json` | Use case 4 — read back |
| `list_traceability_matrices` | `space?`, `name?`, `owned?`, `traceability_only?`, `offset?`, `limit?` | paginated summaries | Use case 4 — find an existing saved matrix (and its id) |

The two ADF tools produce ADF, ready to be published with `contentFormat: "adf"`. Both share the renderers in `adfRender.ts` so RY formatting is identical whether a page is created or edited. **ADF is the single source of truth** — there is no Markdown intermediate and no refine loop (a Markdown roundtrip would destroy an existing page's formatting).

## Version & update check

The server's version has a single source of truth: **`package.json`** (already synced to
`mcpb/manifest.json` by `scripts/build-mcpb.mjs`). `scripts/embed-docs.mjs` bakes it into the
git-ignored `src/version.generated.ts` so the running server knows its own version in both builds
(`tsc`→`dist/` and the self-contained `.mjs` bundle) without reading `package.json` at runtime.
`index.ts` uses it as the `McpServer` version. **Bump the version in `package.json` only.**

The check compares that version against the latest GitHub release
(`GET https://api.github.com/repos/requirement-yogi/ry-ai-assistant/releases/latest`, in
`src/api/githubReleases.ts`) using a small semver comparator. It is **best-effort**: offline /
rate-limited (403) / no-release (404) all yield a `{ checked: false }` result with a note, never an
error.

**It does NOT rely on the LLM calling a tool** (clients often don't). The flow, all in
`src/updateCheck.ts`:
- `index.ts` calls `startUpdateCheck()` at boot → one GitHub round-trip per process (≈ per session),
  cached, with the resolved value mirrored into a plain variable.
- `withTelemetry` (the choke point every tool passes through) calls `takeReadyUpdateNotice()` after
  each tool runs. It's **non-blocking** (returns `undefined` until the startup check has resolved →
  zero added latency) and **one-shot** (fires at most once per session, and only when an update is
  actually available). The banner — a `[Requirement Yogi AI Assistant — update available]` block —
  is prepended to that first tool result. It's skipped for `check_for_updates` itself.
- `check_for_updates` (`src/tools/updates.ts`) remains for an explicit re-check, sharing the same
  cached result.

The server's `instructions` (in `index.ts`) just tell the LLM how to react to the banner; they are
not what triggers the check.

## JSON Schema (Zod)

```typescript
Property          = { label: string, value: string }
RequirementNode   = {
  key?: string,          // free-form identifier, optional — absent on section nodes
  description: string,   // col 2 in a table, text after the macro in a paragraph, heading text
  properties: Property[],// extra table columns only (empty in paragraph/heading contexts)
  children: RequirementNode[]
}
RequirementsTree  = { version: "1.0", project_name, description, created_at, requirements: RequirementNode[] }
```

- **Keys are free-form** — chosen by the user, no imposed format. There is no `title` field; `description` plays that role.
- `key` is **optional**: a node with children is a pure section (rendered as a heading, no macro).
- `properties` is a free array of label/value pairs (always present, may be empty); it only survives in the table context.
- Hierarchy is free in depth.

## Requirement Yogi indexing contexts

A key macro is indexed only in one of three contexts:

1. **Table** — macro in the first column: col 2 = description, cols 3+ = properties (header = label, cell = value). A header row is required.
2. **Paragraph** — macro followed by text: the following text is the description, no properties.
3. **Heading** — macro alone: no description, no properties.

Because every requirement carries a description, a requirement is never placed in a heading when building from scratch — headings are used only for section structure (use case 1) or for keys the user already put in a heading (use case 2).

## Rendering heuristic (`build_requirements_adf`)

Decided by the MCP, not the LLM:

```
node WITH children          → section heading (no macro), then its children below
leaf WITH properties        → table row (key macro | description | one column per property);
                              consecutive leaf siblings sharing the same property labels
                              are merged into one table
leaf WITHOUT properties     → paragraph (key macro followed by the description)
```

## Editing an existing page (`edit_page_requirements`)

This is **not** just "key the text that already fits". The LLM first **analyzes** the page (it has the content): it finds the functional requirements — including those buried in prose — extracts each one's description and properties, and spots properties that recur across requirements. It then passes an ordered plan of typed **operations**; the MCP applies them deterministically on the ADF, preserving everything that is not a requirement.

Four operation modes (all reuse the `adfRender.ts` renderers):

- **`inline`** — `{ key, anchor }`: the requirement already sits in a paragraph/heading that fits a context; just turn the key text into a macro in place.
- **`paragraph`** — `{ key, description, replace_anchors }`: a single textual requirement; replace the matched block(s) with a macro + description paragraph.
- **`table`** — `{ requirements[], replace_anchors }`: several requirements sharing recurring properties; reshape the matched block(s) into one RY table.
- **`insert`** — `{ requirements[], position }`: add requirements that are not described anywhere on the page yet, rendered like a new page (shared properties → a table, no properties → a paragraph). `position` is `{ place: "after_anchor", anchor }` or `{ place: "end" }`.

**Targeting is by anchor text**: `replace_anchors` (reshape) are exact text snippets of the existing block(s) to remove; the result is spliced in at the position of the first match. `insert` uses `position` to add after a block or at the end. The reshape/insert splice happens at the **deepest container** that directly holds the matched blocks, so a wrapping layout/panel is never replaced wholesale. There is **no regex auto-detection** — free-form keys can't be pattern-matched, so the LLM identifies the keys (reusing the page's existing keys, or inventing free-form ones where the page has none).

## Linking requirements to Jira issues (use case 3)

The MCP owns the Requirement Yogi side; the Jira side is delegated to the Atlassian MCP:

- `list_organizations` fetches the organizations the token can see (GET `/organizations` on the
  standalone API — endpoint path to confirm). A single organization is auto-resolved and cached;
  with several, the LLM asks the user which one to use (the organization ID is visible in the RY
  admin panel in Confluence or Jira) and passes `organization_id` to `list_applications`.
- `list_applications` fetches the instances connected to RY (GET `/applications?organizationId=`
  on the standalone API, paginated `{ items, offset, limit, total }`; each item has an `id`, a
  `type` `"JIRA" | "CONFLUENCE" | "STANDALONE"`, a `status`, and a `baseUrl`). JIRA items are the
  source of the `jiraApplicationId` needed for linking; CONFLUENCE items are the source of the
  instance base URL needed by the Confluence API auth (see below). When several instances of a
  type are connected, the LLM asks the user which one to use.
- Reliable RQL is achieved through **three complementary mechanisms**:
  1. **Reference in context** — the authoritative RQL syntax (`src/docs/search-syntax-prompt-v3.md`,
     derived from the backend ANTLR grammar + DSL eval) is embedded in the `search_requirements`
     tool description via `src/prompts/fragments/search-syntax.md`, which includes it at build time
     (never hardcoded).
  2. **Schema grounding** — `list_searchable_fields(space)` returns the space's REAL identifiers so
     the LLM can't invent names (its description says to call it first if unsure). It is built from
     confirmed endpoints only: relationship names from `/relationships`, and properties/variants/
     rules/jira-projects aggregated from a bounded sample (`key ~ '%'`, capped at 1000) of the
     space's own requirements via `/rest/search`. Categories the sampled DTO doesn't expose are
     returned best-effort with a caveat in `notes`.
  3. **Self-correction** — when the RY API answers a bad query with `400 Syntax error at position
     N: …`, `search_requirements` relays that message **verbatim** (never masked) plus a "fix and
     resubmit" hint, so the LLM corrects its RQL and retries.
- `search_requirements` finds the requirements via the RY Confluence API (GET `/rest/search`,
  paginated by 200 with `offset`, optional `spaceKey`). The **LLM writes the query** in RQL.
  The response is a `DTOSearchResult<DTORequirement>`; the tool returns
  `{ total_count, returned, requirements[] }` (never a raw list — `total_count` is the full match
  count, so the LLM can tell too-broad from too-narrow and iterate). Each requirement is **trimmed**
  to the linking essentials (`id`, `key`, `text`, `applicationId`, `containerId`, `variantId`,
  `status`, `canonicalURL`, `properties` — heavy fields like storage data and dependencies are
  dropped, and the default-true `withLinks`/`withOriginalLinks`/`withDependencies` flags are sent as
  false). The pagination envelope (`offset`, `limit`, `hasNext`) and the query feedback
  (`humanReadable`, `messageBean`) are kept.
- Finding existing Jira issues (or creating missing ones) is done by the **Atlassian MCP**
  (`searchJiraIssuesUsingJql` / `createJiraIssue`). The tool descriptions require the LLM to ask
  the user how they want the Jira side structured (one issue per requirement or grouped, epics /
  sub-tasks, project, parent, sprint…) and to get confirmation **before creating anything**.
  Linking needs the **numeric Jira issue IDs**, not the `PROJ-123` keys.
- `list_relationships` fetches the relationship types via the RY standalone API (GET
  `/relationships?applicationId=&offset=&limit=100` — all pages are aggregated; `applicationId`
  is required unless the token is scoped to one application; the user picks the relationship).
- `link_requirements_to_jira` calls the RY link service (POST `/rest/jira-bulk/links` on the
  Confluence API). One operation = a requirement **selection** (`DTORequirementSelection`:
  explicit IDs or query + selectAll, with containerId/variantId) + `jiraApplicationId` +
  `issueIds[]` + `relationshipId`. The tool accepts a batch of operations and reports partial
  failures per operation. The response is a `DTOJiraBulkLinkResult`
  (`linkedCount`/`skippedCount`/`unauthorizedCount`), rendered as a per-operation summary.

## Traceability matrices (use case 4)

A traceability matrix saved query is `{ RQL query + a TREE of columns }`, persisted so it can be
re-run and rendered later. The API used is the **Confluence app API** (`/rest/traceability/…`,
`/rest/saved-matrices`), not the public REST API: the public one exposes neither saved matrices nor
the suggestion mechanism, so it cannot save a query at all.

The hard part is **not** the HTTP call, it is producing columns that are *relevant*.

### There is no "list available columns" endpoint

The column vocabulary is **data-dependent** and there is no global list of it anywhere. The backend
computes suggestions from the requirements actually present in a column's cells (relationships really
declared, properties really observed, link counters). The only way to see them:

`POST /rest/traceability/{spaceKey}` (needs READ on the space) answers, beside the cells, with
**`columnSuggestions`** — an array **indexed by column**, where entry `i` describes what may be added
as a **child of column `i`**. Request body:
`{ traceabilityMatrix: <definition>, pagination: { searchOffset, limit, columnsPagination }, variableValues }`.

**`pagination.columnsPagination` must hold one entry per column index** — the backend does
`columnsPagination.get(column.columnIndex).getLastCellId()` for every column, so `[]` (or anything
shorter than the column count) is an `IndexOutOfBoundsException` server-side. It surfaces as a bare
500 (`"An unexpected error has occurred"`, empty `errors`) that says nothing about the payload, which
is why `columnsPagination()` in `ryClient.ts` derives it from the definition rather than taking it
from a caller. Its entries are `{ lastCellId: null }`: no cursor to resume a column from yet.
Likewise `variants` is written as `[]`, never `null` — both mean "the current variant", and there is
no reason to hand a backend a null collection to iterate.

So discovery is inherently **iterative, one round trip per level of depth**: the suggestions for
level N+1 cannot exist before level N does. `discover_matrix_columns` is that single round trip
(column 0 + the columns already chosen → the candidates for every one of them), and the **LLM walks
the loop** by calling it again with the columns it kept. `services/traceabilityMatrix.ts` owns the
probe; `services/matrixColumns.ts` owns the suggestion → column translation.

### The three traps, all handled in code and covered by tests

1. **The FROM/TO inversion.** `dependencySuggestions.FROM` → a step of type **`TO`**, and
   `dependencySuggestions.TO` → a step of type **`FROM`**. The naive same-name mapping is wrong and
   yields a column that matches nothing. See `SUGGESTION_SIDE_TO_STEP_TYPE`.
2. **`allDependencies` / `allProperties` / `allExternalProperties` are not capability flags.** Their
   value is `!alreadyUsed`: `false` means such a child column already exists there, **never** that
   the data doesn't support it. So a `false` is reported as "already attached" (a duplicate to
   remove), never as an absence of support — in the candidate notes *and* in the rejection message.
3. **`limit` conditions what you discover.** Suggestions derive from the requirements of the current
   page, so every probe uses the full page (`DISCOVERY_LIMIT = 200`) regardless of the `limit` the
   saved definition will carry.

### Validation is on us

The backend validates **exactly one thing** about a matrix definition: that `columns` is non-empty.
A column naming a relationship or property that doesn't exist is persisted without error and only
shows up later as an empty matrix. `save_traceability_matrix` therefore re-validates **every** column
against live suggestions before writing anything, and writes **nothing** if one fails.

That walk is **incremental on purpose**: column N is checked against the suggestions of the matrix
that stops *before* it — the state in which the flags mean what they say (probing with the finished
matrix would report the very aggregate columns being validated as unavailable, per trap 2). It costs
one round trip per column (capped by `MAX_COLUMNS`), and it stops at the **first** rejection, since
the later columns' `parentColumnIndex` refer to positions in the list.

Where the API can't confirm a value, the column is **kept with a warning** rather than rejected: a
Jira field absent from a truncated list (`hasMoreJiraFields`), a `JIRA_RELATIONSHIP` name (gated by
`hasJiraLinks` but never enumerated), a Zephyr Scale / Xray object type (the element shape of those
lists is not part of the documented contract). Rejecting there would be a false negative.

### Why the step-type enum is hard-coded (and what keeps it honest)

`STEP_TYPES` is a closed 23-value enum, which looks like it defeats the point of having a discovery
tool. It does not, and the reason is worth knowing before anyone "fixes" it:

- **The enum is not the coupling.** A suggestion field only becomes a candidate column because
  `candidatesFor` maps it (`propertySuggestions` → `PROPERTY`, `dependencySuggestions.FROM` → `TO`…).
  Opening the enum to `z.string()` would not make a new backend column type appear in discovery — only
  a new mapping does. Nothing would be gained, and the validation would be lost.
- **The enum IS the validated set.** The whole value of this feature is refusing a column the data
  does not support, which requires knowing what a type means and which suggestion field gates it. A
  type nobody has taught the MCP about cannot be checked, so accepting it would mean writing exactly
  the silently-empty matrices this feature exists to prevent.
- **Reading is already lenient**: `StoredMatrixDefinitionSchema` types `step.type` as a plain string,
  so a matrix written by a newer RY version (or by hand in the UI) is read back fine. Only the WRITE
  path is closed.

Two mechanisms keep the hard-coded vocabulary from rotting:

1. **The backend telling us is detected, not missed.** `unmappedSuggestionFields` compares the
   suggestion object against the keys of `ColumnSuggestionsSchema` (a LOOSE object, so unknown fields
   survive) and `discoverMatrixColumns` reports them once per response, pointing at
   `check_for_updates`. A new RY column type therefore surfaces as a visible note instead of being
   silently absent forever. Zero maintenance: declaring the field in the DTO stops the report.
2. **Adding a type is compiler-guided.** Appending one value to `STEP_TYPES` produces exactly three
   errors, which are the three things it needs: a `DEFAULT_LABELS` entry, a `## <TYPE>` section in
   `src/prompts/matrix_columns.md` (via `descriptions.ts`), and a `resolveColumn` case — the `default` branch
   assigns `request.type` to `keyof typeof FLAG_GATED_STEPS`, so a new type cannot silently fall
   through into "treated as a boolean flag". What stays manual is the suggestion field and its mapping,
   which is irreducible: only a human knows that `fooSuggestions[].foo` is the value of type `FOO`.

### The column glossary (what makes the types usable at all)

A step type is an enum name, and a model cannot act on `ORIGINAL_LINKS`. Observed failure: asked to
"add the pages where the requirements are written", the LLM answered that it could not — while
`ORIGINAL_LINKS` was sitting in the suggestions.

The meanings therefore live in **`src/prompts/matrix_columns.md`**, one `## STEP_TYPE` section per type,
written ONCE and used twice:

- **included** in the `discover_matrix_columns` description, so the model knows what exists *before*
  it calls anything (a model that believes a column type doesn't exist never calls discovery to find
  out);
- **parsed** by `embed-docs.mjs` into `COLUMN_MEANINGS`, so every discovery response carries a
  `legend` for the types it actually returned — built per response, not per candidate, or a space
  with 40 properties would repeat one sentence 40 times. "Returned" includes the types a response only
  NAMES in a `note` (`CandidateSet.mentioned`: `JIRA_RELATIONSHIP`, `ZEPHYR_SCALE`, `XRAY`,
  `CALCULATION` are never candidates because their values aren't enumerated) — announcing a possible
  column without explaining it is the same give-up bug as not announcing it at all.

The file opens with a natural-language → column-type mapping ("the document where the requirement is
written" → `ORIGINAL_LINKS`…), which is the part that fixes the give-up behaviour.

**Adding or rewording a meaning is a markdown edit, nothing else.** Completeness is checked in both
directions at COMPILE time in `src/prompts/descriptions.ts` (same mechanism as the tool
descriptions), so the glossary cannot fall behind `StepType`.

### Structural invariants of a definition

- Column 0 is always `{ step: { type: "FIRST_COLUMN", value: null }, columnIndex: 0,
  parentColumnIndex: 0 }` — it holds the requirements the query returned, and it is **its own
  parent**. This MCP injects it; the LLM never passes it (`FIRST_COLUMN` is excluded from the input
  enum).
- `columns` is a **tree**: column N hangs under an existing column of index < N via
  `parentColumnIndex`.
- `columnIndex` is the real index in the array — no holes. Both are checked by `structuralProblems`
  (no round trip) and again by `resolveColumn`.

### Persistence

`POST /rest/saved-matrices` (or `PUT /rest/saved-matrices/{id}`) with a `DTOSavedMatrix`
(`name` ≤ 255, `spaceKey`, `type: "TRACEABILITY"`, `sharedLevel`, `status`, `container`). Two
subtleties, both owned by `toSavedMatrixPayload` and nowhere else:

- **`json` is a String**, not a nested object: it holds `JSON.stringify({ columns, query, variants,
  limit, spaceKey })`.
- A step that carries no value gets **`value: ""`, never `null`** (`NO_STEP_VALUE`). The backend
  tolerates both, but `""` is what Requirement Yogi itself writes. The reference is a real stored
  definition, pinned as a golden test in `tests/services/traceabilityMatrix.test.ts`
  (`REAL_STORED_DEFINITION`) — the shape this MCP must reproduce field for field. Update that
  fixture, not the code's expectations, if a newer product version writes something different.
- **`query` is duplicated** — once at the root (what the saved-matrix list filters on) and once
  inside `json` (what actually runs). Both are read from the same definition so they cannot drift;
  reading a matrix back **warns** when a stored pair has drifted.

**Every** write (create and update alike) carries `ownerAccountId: "FILLED_IN_BACKEND"`
(`BACKEND_FILLED_ACCOUNT`) — the backend resolves the owning account itself, and a client must never
send a real account id (that would be reassigning ownership). `RyClient.savedMatrixBody` injects it for
both paths, alongside the `id` an update repeats in its body. It is deliberately NOT a field of
`SavedMatrixPayload`: going through the transport is the only way it can reach the wire, so no caller
can omit it or substitute an account id.

`status` (`ACTIVE` | `DELETED` | `ARCHIVED`, `MATRIX_STATUSES`) is part of what the REQUEST asks for,
so it lives in `toSavedMatrixPayload` — defaulted to `ACTIVE` and sent on create and update alike —
rather than being hardcoded in the client next to the owner sentinel. `DELETED` is a soft delete; the
tool description tells the LLM to pass either non-default value only when the user asked for it.

**An update is a full PUT, so it reads before it writes.** `PUT /rest/saved-matrices/{id}` replaces the
whole matrix: every field the LLM does not restate would be rewritten with the defaults above, and "add
a Priority column to matrix 42" would un-share it, drop its description, reset a custom `limit`, drop
its variant filter and bring an `ARCHIVED` matrix back to life. So a `matrixId` makes
`saveTraceabilityMatrix` `GET` the stored matrix FIRST (`preservedFields`) and use its own values as the
fallbacks for `description` / `sharedLevel` / `status` / `limit` / `variants`; only what the caller
states changes, and whatever was carried over is reported in the `warnings`. That read is deliberately
uncaught — if the matrix can't be read, nothing can be preserved, and failing beats silently resetting
someone's saved query. The preserved `variants` also feed the validation probes, or a column would be
checked against data the saved matrix will not show. `columns` and `query` are NOT preserved: they are
the point of the update, and the tool description says an update replaces the column tree rather than
adding to it.

Reading back: `GET /rest/saved-matrices/{id}` → `JSON.parse(response.json)` (lenient schema, so a
matrix authored by a newer version or in the UI still parses; an unusable `json` is a
`RyResponseError`). `POST /rest/saved-matrices/search?offset=&limit=` with `RYEntityFilters`
(`owned` is required) → one paginated page. `DELETE /rest/saved-matrices/{id}` → 204 (on the client
only — no MCP tool deletes a user's saved query).

### Configuration (MCP server environment)

| Env var | Value |
|---|---|
Runtime (MCP `mcpServers` env) — **same for dev and prod**:

| Env var | Value |
|---|---|
| `RY_PERSONAL_ACCESS_TOKEN` | RY personal access token |
| `RY_DATA_RESIDENCY` | `EU` or `US` — mapped internally to the right API hosts (prod only; ignored in dev) |

Build-time (baked by `scripts/build-bundle.mjs`, **not** in the MCP config):

| Baked var | Value |
|---|---|
| `RY_ENV` | `dev` or `prod` (default `prod`). Baked by `build:dev`/`build:prod`; selects the *mode* only. Internal — never document it in the public README. |
| `RY_DEV_FORGE_ENV_ID` | **dev only, from `.env.dev`** — this developer's Forge environment id (the middle UUID of the requirement-yogi extension key). Required for `build:dev`. Prod uses the fixed source constant `126ed95b-…`; the `application_id` (`2237ccc1-…`) is constant across environments. |
| `RY_DEV_CONFLUENCE_URL` | **dev only, from `.env.dev`** — this developer's Confluence dev instance base URL (their own tunnel). Required for `build:dev`. |
| `RY_DEV_STANDALONE_URL` | **dev only, from `.env.dev`** — this developer's standalone API base URL. Optional; defaults to `http://localhost:8082/api`. |

Hosts per residency (in `src/api/ryClient.ts`): old Confluence REST API
`https://confluence[.us].requirementyogi.com` (search + jira-bulk links + traceability/saved
matrices), new standalone API
`https://api[.us].requirementyogi.com/api` (applications + relationships).

**Auth differs per API**: the standalone API takes `Authorization: Bearer <token>`; the Confluence
API takes two headers, `X-Api-Key: <token>` and `X-Base-Url: <Confluence instance base URL>`. The
base URL is auto-resolved (and cached) via GET `/applications` when a single active Confluence
instance is connected; when several are, the error tells the LLM to ask the user which instance
to use and to pass the tools' optional `base_url` parameter (from `list_applications`).

## User Flow

```
Use case 1 (create):
  [User] prompt → LLM decomposes into a requirements tree → build_requirements_adf → ADF
  → publish via Atlassian MCP createConfluencePage (contentFormat: "adf")

Use case 2 (edit):
  [User] points at a page → fetch its ADF (getConfluencePage) → LLM analyzes it and proposes a plan
  → user confirms → edit_page_requirements → modified ADF → publish via updateConfluencePage (version + 1)

Use case 3 (link to Jira):
  [User] asks to link requirements to Jira → (list_searchable_fields to ground the query)
  → search_requirements (RY IDs)
  → find/create the Jira issues via Atlassian MCP (user chooses the structure first)
  → list_relationships (user picks the relationship) → link_requirements_to_jira

Use case 4 (traceability matrix saved query):
  [User] asks for a matrix → LLM writes the RQL query for the ROOT requirements
  → discover_matrix_columns (no columns) → LLM picks columns
  → discover_matrix_columns (with them) → … one call per level of depth
  → user confirms the plan → save_traceability_matrix (validates every column, then persists)
  → get_traceability_matrix / list_traceability_matrices to read back
```

## What remains to be done

- [x] Tests on `adfRender.ts` (pure) and on `editPage.ts` helpers (`applyReplace`/`anchoredInject`/`applyInsertAfter`, exported) covering table grouping and nested-container splicing
- [ ] Tests on the `edit_page_requirements` **handler** (the four operation modes end to end); the helpers underneath are covered, the operation dispatch is not
- [ ] `applyReplace`/`applyInsertAfter` act on a single deepest container — anchors spanning two different containers only handle the first; revisit if needed
- [ ] Decide whether a section node should ever also be an indexed requirement (currently a parent's `key` is ignored)
- [ ] Fine-tune tool descriptions based on LLM quality feedback — now a pure markdown edit under `src/prompts/tools/`
- [ ] Use case 4: confirm the element shape of `zephyrScaleFields` / `xrayFields` and the response shape of `POST /rest/saved-matrices/search` against the real API — the first is only loosely matched (a miss warns instead of rejecting) and the second goes through the lenient `extractItems` envelope
- [ ] Use case 4: no MCP tool deletes a saved matrix; `RyClient.deleteSavedMatrix` exists if one is ever wanted
- [ ] Use case 3: confirm the `GET /organizations` endpoint path/shape on the standalone API (assumed from the `?organizationId=` param of `/applications`), then test the whole flow against the real RY APIs. The DTOs in `src/api/dto.ts` are deliberately lenient until then — tighten them (and drop the `nullish`) once the shapes are confirmed
```
