<!--
The preamble below is prompt text. Everything after it is the AUTHORITATIVE RQL reference,
included verbatim from src/docs/search-syntax-prompt-v3.md (derived from the backend ANTLR
grammar + DSL evaluation code). NEVER re-hardcode the syntax here — edit that .md instead.
HTML comments like this one are stripped at build time and never reach the model.
-->
HOW TO WRITE THE QUERY — Requirement Yogi (RQL) search syntax reference.

A query is a structured boolean expression of "field operator value" conditions — NOT a free-text
search box. A bare term (a key, a word, an ID) on its own is NOT valid: wrap it in a condition,
e.g. the key BREW-F-01 becomes `key = 'BREW-F-01'` (exact) or `key ~ 'BREW-F-01%'` (prefix).
When the user names no field, default to `key`. Only use field/property/relationship/variant
names you know exist — if unsure, call list_searchable_fields(space) FIRST to get the real ones.

{{include:../../docs/search-syntax-prompt-v3.md}}
