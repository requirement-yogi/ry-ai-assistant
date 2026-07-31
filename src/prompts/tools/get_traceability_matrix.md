USE THIS TOOL to read a saved traceability matrix back: its name, its query and its full column tree. Use it to confirm what was saved, or to inspect an existing matrix before replacing it with save_traceability_matrix (pass its `matrix_id` there to update it in place).

The definition is stored as a serialised string inside the saved matrix; this tool parses it for you and returns it as `definition` ({ columns, query, variants, limit, spaceKey }).

Read `warnings`: they flag a definition that cannot render (no columns) or a saved matrix whose root query has drifted from the one inside its definition — in which case the matrix lists under one query and runs another, and re-saving it is the fix.

Get the `matrix_id` from list_traceability_matrices, or from the report of save_traceability_matrix.

{{include:../fragments/traceability-workflow.md}}
