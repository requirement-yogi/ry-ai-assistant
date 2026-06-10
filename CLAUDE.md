# RY AI Assistant — MCP Server

## What this project does

An MCP (Model Context Protocol) server in TypeScript that gives an LLM client (Claude Desktop, Claude Code, Cursor…) the ability to place **Requirement Yogi macros** correctly into Confluence pages — in Atlassian Document Format (ADF).

It covers two use cases:
1. **Create a new Confluence page** from a structured requirements tree, with the RY macros placed in valid indexing contexts.
2. **Edit an existing Confluence page** by injecting RY macros in place, preserving the page's original format.

This MCP is **not** a document-authoring tool. Its single value is owning the **Requirement Yogi indexing rules**: only it knows where a macro may live in a page and what each context indexes. The intelligence is encoded in the server (deterministic `tree → ADF` rendering), not in LLM instructions.

**Division of work:** the client LLM does the decomposition (breaking the request into a requirements tree) and decides what to key on an existing page; the MCP produces/modifies the ADF deterministically and validates the input (Zod). No server-side LLM calls. Publishing to Confluence is delegated to another available tool (e.g. the Atlassian MCP `createConfluencePage` / `updateConfluencePage`).

## Stack

- TypeScript + Node.js (ESM)
- `@modelcontextprotocol/sdk` for the MCP server
- `zod` v4 for schema validation
- Transport: stdio (standard MCP)

## Commands

```bash
npm run build   # compile TypeScript → dist/
npm start       # run the compiled build (node dist/index.js)
```

> Note: `tsx`/`npm run dev` is currently broken in the Linux sandbox (the installed esbuild
> binary targets macOS). Run via the compiled `dist/` instead: `npm run build && node dist/...`.

## Architecture

```
src/
├── index.ts                  # MCP server, registers the 2 tools
├── schemas/requirements.ts   # Zod schema + TypeScript types for the requirements tree
└── tools/
    ├── buildAdf.ts           # build_requirements_adf — tool wrapper (use case 1)
    ├── editPage.ts           # edit_page_requirements — analyze + reshape an existing page (use case 2)
    ├── adfRender.ts          # shared deterministic renderers: tree→ADF, table, paragraph (the RY intelligence)
    ├── macro.ts              # buildInlineExtension — shared RY macro node, single source of truth
    └── indexingRules.ts      # KEY_RULES + INDEXING_CONTEXTS — the RY rules surfaced to the LLM
```

`src/auth/keycloak.ts` is legacy and currently unused (not imported anywhere).

## The 2 MCP Tools

| Tool | Input | Output | Role |
|---|---|---|---|
| `build_requirements_adf` | `tree` (requirements JSON) | ADF body | Use case 1 — render a new page from scratch |
| `edit_page_requirements` | `page_adf`, `operations[]` | modified ADF body | Use case 2 — analyze an existing page and reshape it for indexing |

Both produce ADF, ready to be published with `contentFormat: "adf"`. Both share the renderers in `adfRender.ts` so RY formatting is identical whether a page is created or edited. **ADF is the single source of truth** — there is no Markdown intermediate and no refine loop (a Markdown roundtrip would destroy an existing page's formatting).

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

## User Flow

```
Use case 1 (create):
  [User] prompt → LLM decomposes into a requirements tree → build_requirements_adf → ADF
  → publish via Atlassian MCP createConfluencePage (contentFormat: "adf")

Use case 2 (edit):
  [User] points at a page → fetch its ADF (getConfluencePage) → LLM analyzes it and proposes a plan
  → user confirms → edit_page_requirements → modified ADF → publish via updateConfluencePage (version + 1)
```

## What remains to be done

- [ ] Tests on `adfRender.ts` (pure) and on `editPage.ts` helpers (`applyReplace`/`anchoredInject`/`applyInsertAfter`, exported) covering the four operation modes, table grouping, and nested-container splicing
- [ ] `applyReplace`/`applyInsertAfter` act on a single deepest container — anchors spanning two different containers only handle the first; revisit if needed
- [ ] Decide whether a section node should ever also be an indexed requirement (currently a parent's `key` is ignored)
- [ ] Fine-tune tool descriptions based on LLM quality feedback
- [ ] Remove or wire up the legacy `src/auth/keycloak.ts`
```
