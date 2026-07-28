USE THIS TOOL to discover the REAL searchable identifiers of a Confluence space before you write an RQL query. CALL THIS FIRST whenever you are not sure which fields, properties or relationships a space actually has — it is what prevents you from inventing names that don't exist.

Returns JSON with, for the given space:
- properties: the requirement property names → use as @Name (e.g. @Priority).
- external_properties: typed/external property names → use as ext@Name (support > >= < <=).
- relationships: relationship names → use as from@Name / to@Name / parent@Name / child@Name / jira@Name.
- variants, baselines, rules, jira_projects: names for variant/baseline/ruleStatus@/project conditions (best-effort — see notes).
- sampled: how many requirements were inspected; notes: caveats.

Escape spaces in a name with a backslash when writing the query (e.g. @Main\ Category). Build the query with search_requirements using ONLY the identifiers returned here (plus the always-available core fields: key, text, page, status, jira…).

{{include:../fragments/jira-workflow.md}}
