USE THIS TOOL as the FINAL step when the user wants to link Requirement Yogi requirements to Jira issues.

Creates the links through the Requirement Yogi link service. Each entry links a SELECTION of requirements (explicit IDs, or a query with select_all) to a set of Jira issues with one relationship — e.g. "one issue per requirement" is one entry per pair, while "these 5 requirements all relate to this epic" is a single entry.

Requirements: use the IDs and container/variant IDs from search_requirements.
Jira issues: NUMERIC issue IDs (not PROJ-123 keys) — resolve them with the Atlassian MCP tools, which also handle finding or creating the issues.
Relationship: ID from list_relationships.

Only call it once the Jira issues exist and the user has confirmed the plan (issue structure AND relationship type).

{{include:../fragments/jira-workflow.md}}
