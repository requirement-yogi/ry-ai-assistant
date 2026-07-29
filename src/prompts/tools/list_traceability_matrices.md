USE THIS TOOL to find the saved matrices that already exist — to show the user what they have, to get the `matrix_id` of one, or to check a name is not already taken before saving a new one.

Filters: `space`, `name`, `owned` (true by default — the user's own matrices; false also brings in the shared ones), `traceability_only` (true by default; set false to also list MODIFICATION and COVERAGE matrices). Paginated with `offset` / `limit` (50 per page by default).

Only a summary of each matrix is returned (id, name, description, space, type, status, shared level, query). Call get_traceability_matrix with an id to see its columns.

{{include:../fragments/traceability-workflow.md}}
