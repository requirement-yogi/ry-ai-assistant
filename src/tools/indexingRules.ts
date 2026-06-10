// Requirement Yogi indexing rules — the knowledge that gives this MCP its value.
// Keys are free-form (chosen by the user); the rules are about WHERE a macro can
// live in a Confluence page and what each context indexes.

export const KEY_RULES = `
REQUIREMENT KEY RULES:
- Keys are free-form — the user picks them (e.g. F-01, AUTH-002, WEBHOOK, REQ.payment.3). Do NOT impose a format.
- When a page already uses keys, reuse them exactly — never rename or invent a new format.
- Each key is indexed once: never place the same key macro in two locations.`

export const INDEXING_CONTEXTS = `
REQUIREMENT YOGI INDEXING CONTEXTS — a key macro is only indexed in one of these three places:

1. TABLE — key macro in the FIRST column of a row:
   - column 2 is interpreted as the requirement DESCRIPTION
   - columns 3+ become PROPERTIES (label = column header, value = cell)
   - a header row is required so property columns get their labels

2. PARAGRAPH — key macro inside a paragraph:
   - the text following the macro is the DESCRIPTION
   - no properties possible in this context

3. HEADING — key macro inside a heading:
   - no description, no properties (title-only marker)

A macro placed anywhere else (list item, blockquote, code block) is NOT indexed.`
