# RY AI Assistant — MCP Server

## What this project does

An MCP (Model Context Protocol) server in TypeScript that gives an LLM client (Claude Desktop, Claude Code, Cursor…) the ability to place **Requirement Yogi macros** correctly into Confluence pages — in Atlassian Document Format (ADF).

It covers three use cases:
1. **Create a new Confluence page** from a structured requirements tree, with the RY macros placed in valid indexing contexts.
2. **Edit an existing Confluence page** by injecting RY macros in place, preserving the page's original format.
3. **Link requirements to Jira issues** through the Requirement Yogi API (finding/creating the Jira issues themselves is delegated to the Atlassian MCP).

This MCP is **not** a document-authoring tool. Its single value is owning the **Requirement Yogi indexing rules**: only it knows where a macro may live in a page and what each context indexes. The intelligence is encoded in the server (deterministic `tree → ADF` rendering), not in LLM instructions.

**Division of work:** the client LLM does the decomposition (breaking the request into a requirements tree) and decides what to key on an existing page; the MCP produces/modifies the ADF deterministically and validates the input (Zod). No server-side LLM calls. Publishing to Confluence is delegated to another available tool (e.g. the Atlassian MCP `createConfluencePage` / `updateConfluencePage`).

## Stack

- TypeScript + Node.js (ESM)
- `@modelcontextprotocol/sdk` for the MCP server
- `zod` v4 for schema validation
- Transport: stdio (standard MCP)

## Commands

```bash
npm run build        # full build: tsc → dist/ + both esbuild bundles into standalone/
npm run build:prod   # prod bundle only → standalone/ry-ai-assistant.mjs
npm run build:dev    # dev bundle only  → standalone/ry-ai-assistant-dev.mjs (local hosts baked in)
npm run compile      # tsc only → dist/ (also what `prepare`/`npm install` runs)
npm start            # run the compiled dist build (node dist/index.js)
```

The dev/prod split is **baked at build time** via esbuild `--define:process.env.RY_ENV=...`, so
each bundle is a self-contained `.mjs` with its environment hard-wired (the prod bundle still reads
`RY_DATA_RESIDENCY` at runtime; the dev bundle forces the local hosts — see `DEV_HOSTS` in
`src/api/ryClient.ts`). The dev bundle is internal only and must not be referenced in the public
README.

> Note: the `build:prod`/`build:dev` (and therefore `build`) steps need a platform-native esbuild.
> In the Linux sandbox the installed esbuild binary targets macOS, so those steps fail here — use
> `npm run compile` in the sandbox and run the full `npm run build` on macOS.

## Architecture

```
src/
├── index.ts                  # MCP server, registers the 8 tools
├── schemas/requirements.ts   # Zod schema + TypeScript types for the requirements tree
├── api/
│   └── ryClient.ts           # HTTP client for the RY APIs (applications, search, relationships, links)
└── tools/
    ├── buildAdf.ts           # build_requirements_adf — tool wrapper (use case 1)
    ├── editPage.ts           # edit_page_requirements — analyze + reshape an existing page (use case 2)
    ├── jiraLinks.ts          # the 6 use-case-3 tools (organizations, applications, searchable-fields, search, relationships, links)
    ├── searchSyntax.ts       # SEARCH_SYNTAX — RQL reference surfaced to the LLM; loaded from docs/search-syntax-prompt-v3.md (never hardcoded)
    ├── adfRender.ts          # shared deterministic renderers: tree→ADF, table, paragraph (the RY intelligence)
    ├── macro.ts              # buildInlineExtension — shared RY macro node, single source of truth
    └── indexingRules.ts      # KEY_RULES + INDEXING_CONTEXTS — the RY rules surfaced to the LLM
docs/
    └── search-syntax-prompt-v3.md   # AUTHORITATIVE RQL syntax (from the backend ANTLR grammar + DSL eval); single source of truth
scripts/
    └── embed-docs.mjs        # build-time codegen: docs/*.md → src/docs/*.generated.ts (imported by both tsc and esbuild builds)
```

The RQL reference is written **once** in `src/docs/search-syntax-prompt-v3.md`. `scripts/embed-docs.mjs`
(run by `generate:docs`, and automatically by `compile`/`bundle`) embeds it into a git-ignored
`*.generated.ts` module, so `searchSyntax.ts` imports it and it can never drift — edit the markdown,
never re-hardcode the syntax. Codegen (rather than a runtime `readFileSync`) is what lets the same
import work in both the `tsc`→`dist/` build and the self-contained esbuild `.mjs` bundle.

## The MCP Tools

| Tool | Input | Output | Role |
|---|---|---|---|
| `build_requirements_adf` | `tree` (requirements JSON) | ADF body | Use case 1 — render a new page from scratch |
| `edit_page_requirements` | `page_adf`, `operations[]` | modified ADF body | Use case 2 — analyze an existing page and reshape it for indexing |
| `list_organizations` | — | organizations JSON (IDs + names) | Use case 3 — only when the token spans several organizations |
| `list_applications` | `organization_id?` | applications JSON (IDs + base URLs) | Use case 3 — discover the connected instances |
| `list_searchable_fields` | `space`, `application_id?`, `base_url?` | JSON of the space's real identifiers (properties, external, relationships, variants…) | Use case 3 — schema grounding: call before writing a query to avoid inventing field names |
| `search_requirements` | `query` (RQL), `space_key?`, `offset?`, `base_url?` | `{ total_count, returned, requirements[] }` (IDs + container/variant) | Use case 3 — discover the RY requirements; relays RQL parse errors verbatim for self-correction |
| `list_relationships` | `application_id?` | relationships JSON (with IDs) | Use case 3 — discover the available relationship types |
| `link_requirements_to_jira` | `links[]` (selection, jira_application_id, issue_ids, relationship_id), `base_url?` | creation report | Use case 3 — create the links via the RY jira-bulk service |

The two ADF tools produce ADF, ready to be published with `contentFormat: "adf"`. Both share the renderers in `adfRender.ts` so RY formatting is identical whether a page is created or edited. **ADF is the single source of truth** — there is no Markdown intermediate and no refine loop (a Markdown roundtrip would destroy an existing page's formatting).

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
     tool description via `searchSyntax.ts`, loaded from the file at build time (never hardcoded).
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

### Configuration (MCP server environment)

| Env var | Value |
|---|---|
| `RY_ENV` | `dev` or `prod` (default `prod`). Baked into the bundle at build time (esbuild `--define`, via `build:dev`/`build:prod`). `dev` forces the local dev hosts (see `DEV_HOSTS` in `src/api/ryClient.ts`) and ignores `RY_DATA_RESIDENCY`. Internal only — never document it in the public README. |
| `RY_DATA_RESIDENCY` | `EU` or `US` — mapped internally to the right API hosts (prod only) |
| `RY_PERSONAL_ACCESS_TOKEN` | RY personal access token |

Hosts per residency (in `src/api/ryClient.ts`): old Confluence REST API
`https://confluence[.us].requirementyogi.com` (search + jira-bulk links), new standalone API
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
```

## What remains to be done

- [ ] Tests on `adfRender.ts` (pure) and on `editPage.ts` helpers (`applyReplace`/`anchoredInject`/`applyInsertAfter`, exported) covering the four operation modes, table grouping, and nested-container splicing
- [ ] `applyReplace`/`applyInsertAfter` act on a single deepest container — anchors spanning two different containers only handle the first; revisit if needed
- [ ] Decide whether a section node should ever also be an indexed requirement (currently a parent's `key` is ignored)
- [ ] Fine-tune tool descriptions based on LLM quality feedback
- [ ] Use case 3: confirm the `GET /organizations` endpoint path/shape on the standalone API (assumed from the `?organizationId=` param of `/applications`), then test the whole flow against the real RY APIs
```
