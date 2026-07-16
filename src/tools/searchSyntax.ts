// The Requirement Yogi RQL search syntax, surfaced to the client LLM so it can translate the
// user's request into valid queries for search_requirements.
//
// SOURCE OF TRUTH: src/docs/search-syntax-prompt-v3.md (derived from the backend ANTLR grammar
// + DSL evaluation code). It is embedded at build time by scripts/embed-docs.mjs into
// searchSyntaxReference.generated.ts, so this reference can NEVER drift from the .md — edit the
// markdown, never this string. Do not re-hardcode the syntax here.

import { SEARCH_SYNTAX_REFERENCE } from "../docs/searchSyntaxReference.generated.js"

// Maintainer-facing HTML comments in the .md (the "do NOT reintroduce excel/isModified…" note)
// are noise for the model — strip them, keep everything else verbatim.
const referenceForLlm = SEARCH_SYNTAX_REFERENCE.replace(/<!--[\s\S]*?-->/g, "").trim()

export const SEARCH_SYNTAX = `HOW TO WRITE THE QUERY — Requirement Yogi (RQL) search syntax reference.

A query is a structured boolean expression of "field operator value" conditions — NOT a free-text
search box. A bare term (a key, a word, an ID) on its own is NOT valid: wrap it in a condition,
e.g. the key BREW-F-01 becomes \`key = 'BREW-F-01'\` (exact) or \`key ~ 'BREW-F-01%'\` (prefix).
When the user names no field, default to \`key\`. Only use field/property/relationship/variant
names you know exist — if unsure, call list_searchable_fields(space) FIRST to get the real ones.

${referenceForLlm}`
