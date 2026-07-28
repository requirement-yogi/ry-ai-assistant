USE THIS TOOL when the user wants to create a NEW Confluence page from a set of requirements.

This MCP owns the Requirement Yogi indexing rules. You provide a structured requirements tree;
it deterministically produces an Atlassian Document Format (ADF) body with the Requirement Yogi
macros placed in valid indexing contexts. You do NOT write ADF or Markdown yourself.

How the tree is rendered (decided by this tool, not by you):
- A node WITH children → a section heading (no macro), then its children below.
- A leaf WITH properties → a table row (key macro | description | one column per property).
  Consecutive leaf siblings that share the same property labels are merged into one table.
- A leaf WITHOUT properties → a paragraph (key macro followed by the description).

Your job is the decomposition: break the user's request into a hierarchy of requirements, each with
a free-form key, a description, and optional properties (label/value). Leave a node's key empty when
it is only a section grouping its children.

{{include:../fragments/key-rules.md}}

{{include:../fragments/indexing-contexts.md}}

After this tool returns, publish the ADF with another available tool (e.g. Atlassian MCP
createConfluencePage) using contentFormat "adf".
