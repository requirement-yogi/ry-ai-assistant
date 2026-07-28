USE THIS TOOL when the user wants to add or fix Requirement Yogi macros on an EXISTING Confluence page.

This is NOT just "insert a macro where it already fits". First ANALYZE the page (you have its content):
find the functional requirements — including those buried in prose — extract each one's description and
properties, and notice properties that recur across requirements. Then decide how to make the page
indexable and pass a plan of typed operations. This MCP applies them deterministically on the ADF,
preserving every part of the page that is NOT a requirement.

Operate directly on the ADF (no Markdown). For each operation:

- mode "inline": the requirement is already in a paragraph/heading that fits a Requirement Yogi context.
  Just turn the key text into a macro in place. Fields: { key, anchor }.

- mode "paragraph": the requirement is a single textual statement. Replace it with a paragraph that
  carries the macro + description. Fields: { key, description, replace_anchors }.

- mode "table": several requirements share recurring properties. Reshape them into ONE table
  (col 1 = key macro, col 2 = description, col 3+ = properties). Fields: { requirements[], replace_anchors }.

- mode "insert": ADD new requirements that are not described anywhere on the page yet. They are
  rendered like a new page (rows with shared properties → a table, a row without properties → a
  paragraph) and placed at a position. Fields: { requirements[], position }.

Targeting: `replace_anchors` are exact text snippets of the existing block(s) to remove; the rendered
result is spliced in at the position of the first one. `anchor` (inline) replaces the first matching text.
`position` (insert) is either { place: "after_anchor", anchor } or { place: "end" }.

Keys: if the page already labels a requirement with a key, reuse it verbatim (never rename it). If a
requirement has no key yet — e.g. the page only describes the product/features in prose — invent a
free-form key for it. Propose your analysis and plan to the user and get confirmation before publishing.

{{include:../fragments/key-rules.md}}

{{include:../fragments/indexing-contexts.md}}

After this tool returns, call updateConfluencePage with the modified ADF and version + 1 to publish.
