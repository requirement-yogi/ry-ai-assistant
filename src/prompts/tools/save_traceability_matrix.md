USE THIS TOOL to persist a traceability matrix as a Requirement Yogi saved query: a name plus the RQL query and the column tree you built with discover_matrix_columns. Pass `matrix_id` to replace an existing saved matrix instead of creating a new one.

BEFORE CALLING IT: every column must come from discover_matrix_columns (same `type`, same `value`, same `parent_column_index`), and the user must have confirmed the plan — this writes to their space.

WHAT IT DOES FOR YOU: it re-validates each column against the suggestions the API returns for the column it hangs under, in the state the matrix is in just before that column is added. If one column does not match the data, NOTHING is written and you get the reason plus the values that were actually available. Requirement Yogi itself only checks that a matrix has at least one column, so this validation is the only thing standing between the user and a matrix that saves cleanly and renders empty.

Validation stops at the FIRST rejected column, because the columns after it refer to positions in the list you sent. Fix that one, re-run discover_matrix_columns if you need to see the real vocabulary again, and call this tool again.

Inputs worth care:
- `query`: the same query you validated with discover_matrix_columns. It is stored both at the root of the saved matrix and inside its definition; this tool keeps the two in sync for you.
- `columns`: in definition order. Column 0 (the requirements column) is added automatically — do not include it. Set `label` on each column for a readable header.
- `variants`: variant IDs to filter on; omit for the current variant. `limit`: how many requirements the matrix renders (default 200).
- `shared_level`: NONE (private to the user), SHARED_VIEW or SHARED_EDIT — ask the user unless they said. Defaults to NONE on a new matrix.
- `matrix_id`: replaces an existing saved matrix. An update rewrites the WHOLE matrix, so anything you do not restate (`description`, `shared_level`, `status`, `limit`, `variants`) is carried over from the stored matrix and reported in the warnings — state a field only when the user wants it changed. `columns` and `query`, on the other hand, are always taken from what you send: an update replaces the column tree, it does not add to it, so pass the full list you want the matrix to end up with.

The result reports the id of the saved matrix, the validated columns, and any `warnings` — columns that were kept but could not be fully verified (a truncated Jira field list, a Jira relationship name the API does not enumerate). Relay warnings to the user: those columns may still come out empty.

{{include:../fragments/traceability-workflow.md}}
