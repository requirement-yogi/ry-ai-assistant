---
name: architecture-adf-centric
description: Core architecture decision — the MCP is ADF-centric, no Markdown/refine; it encodes Requirement Yogi indexing rules
metadata:
  type: project
---

The MCP's single purpose is to place Requirement Yogi macros correctly into Confluence ADF — it is NOT a document authoring tool. Only we know the RY indexing rules, so the intelligence (deterministic `tree → ADF` rendering) lives in the server, not in LLM instructions.

Decisions (2026-06-10):
- **Dropped** the Markdown intermediate, the `refine` loop, and the `mdToAdf` parser. ADF is the single source of truth; Markdown roundtrips would destroy an existing page's format.
- Two flows, both on ADF, sharing the renderers in `tools/adfRender.ts`: **create from scratch** (`build_requirements_adf`, tree → ADF) and **edit existing page** (`edit_page_requirements`, ADF → ADF).
- Requirement node model = `{ key?, description, properties[], children[] }`. No `title`. `key` is optional (a node with children = section heading, no macro). Keys are **free-form** (no regex format).
- Rendering heuristic (decided by the MCP, not the LLM): node with children → heading (no macro); leaf with non-empty properties → table row (sibling rows sharing the same property labels grouped into one table); leaf with empty properties → paragraph.
- RY's 3 contexts: table (col1=key, col2=description, col3+=properties keyed by header), paragraph (text after macro = description), heading (key only, no description/properties). Since every requirement has a description, a requirement never lives in a heading from-scratch.
- Editing (use case 2) is NOT just "macro where it fits": the LLM analyzes the page, finds functional requirements (even in prose), spots recurring properties, and may reshape format for indexability. `edit_page_requirements` takes a plan of typed operations: `inline` (key text→macro in place), `paragraph` (block→macro+description), `table` (blocks→one RY table), `insert` (add net-new requirements at `position` = after_anchor | end). Reshape ops target by anchor text (`replace_anchors`/`anchor`); the splice happens at the deepest container so wrappers (panel/layout) survive. Keys: reuse the page's existing ones, or invent free-form keys where the page only has prose. No regex auto-detect — free-form keys can't be pattern-matched.
