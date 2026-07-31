USE THIS TOOL to find out which columns a traceability matrix can actually carry, before you build one. CALL IT FIRST, and CALL IT AGAIN for every level of depth you add — it is the only source of truth for the column vocabulary, and that vocabulary depends on the data the query returns, not on a fixed list.

Give it the space, the RQL query selecting the root requirements, and the columns you have already picked (none on the first call). It renders a probe matrix and returns, for EVERY column of it, the columns you can attach as its children:

- `columns[i].candidates`: ready-to-use column definitions — `type`, `value`, `parent_column_index`, `suggested_label`. Pass them back verbatim in `columns` (of this tool to go deeper, or of save_traceability_matrix to persist). Do not edit `type` or `value`; `label` is yours to make readable.
- `legend`: what each column type in the response MEANS. A type like ORIGINAL_LINKS is an enum name, not an explanation — read the legend before deciding a request cannot be satisfied.
- `columns[i].notes` and the top-level `notes`: what the API said WITHOUT offering a column — an all* flag that is false because such a column already exists there, a truncated Jira field list, Zephyr Scale/Xray availability, calculation support.

Column 0 is the requirements column; it always exists and this tool adds it for you — never pass it in `columns`. Every other column hangs under an existing one through `parent_column_index`, so `columns` is a tree, not a flat list.

WHY THE LOOP: the suggestions for a column are computed from the requirements really present in its cells, so what can be attached under a column is unknowable until that column exists. Add one level, call again, add the next.

EMPTY CANDIDATES ARE AN ANSWER: if a column comes back with no candidates, nothing can be attached under it (often because the query matches nothing, or because the requirements there have no dependencies/properties). Do not invent one — tell the user.

{{include:../fragments/traceability-workflow.md}}

{{include:../matrix_columns.md}}

{{include:../fragments/search-syntax.md}}
