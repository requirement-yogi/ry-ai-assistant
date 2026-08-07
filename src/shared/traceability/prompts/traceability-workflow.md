<!--
Shared by the four traceability tools. The three traps it insists on (data-dependent vocabulary,
all* = already used, validation before persistence) are the reasons this MCP owns the feature at
all — if the model treats the column list as static, it will produce empty matrices.
-->
Full workflow for creating a traceability matrix saved query (you orchestrate it):

1. Agree with the user on the Confluence space and on what the matrix must show.
2. Write the RQL query that selects the ROOT requirements — the ones column 0 will hold. Every
   column of the matrix hangs off those, so the query decides the whole vocabulary that follows.
   If you are unsure which fields/properties exist, call list_searchable_fields(space) first; you
   can also run the query through search_requirements to check it matches what the user meant.
3. Call discover_matrix_columns with the space and the query and NO columns. It answers with the
   columns you can attach under column 0.
4. Pick the ones that answer the user's need, then call discover_matrix_columns AGAIN with the
   columns you kept, to see what can be attached UNDER them. Repeat once per level of depth: the
   suggestions for a column cannot exist before that column does, so this is an iterative loop, one
   round trip per level. Columns form a TREE — parent_column_index says what each one hangs under.
5. Show the plan to the user and get their confirmation before writing anything. If the space uses
   variants, ask which one the matrix is for and pass its ID in `variants` — search_requirements
   reports each requirement's `variantId`. Omitting it means "the current variant".
6. Call save_traceability_matrix. It re-validates every column against the live suggestions and
   REFUSES to write anything if one of them does not match the data, so a saved query is never
   silently empty. If it refuses, read the problem, call discover_matrix_columns again, fix the plan.
7. Read it back with get_traceability_matrix (or find it with list_traceability_matrices).

THREE THINGS TO KNOW, they are the difference between a saved query and a USEFUL saved query:

- THE COLUMN VOCABULARY IS DATA-DEPENDENT. There is no global list of available columns, and no
  endpoint that could give you one: Requirement Yogi derives the suggestions from the requirements
  that are really in each column. NEVER invent a relationship, property or Jira field name — only
  use what discover_matrix_columns returned for that exact parent column.
- A FALSE all* FLAG MEANS "ALREADY USED", NOT "UNSUPPORTED". allDependencies / allProperties /
  allExternalProperties turn false once such a column is already attached to that column. Never
  conclude from a false that the space does not support it.
- THE SERVER VALIDATES ALMOST NOTHING. It only checks that a matrix has at least one column: a
  column pointing at something that does not exist is saved without any error and shows up as an
  empty matrix days later. That is why save_traceability_matrix re-checks everything and why you
  must not try to work around a rejection.
