USE THIS TOOL to discover the Confluence and Jira instances connected to Requirement Yogi, typically as the first step of linking requirements to Jira issues.

Returns the applications as JSON (all pages are fetched for you). Each item has an id, a type ("JIRA" | "CONFLUENCE" | "STANDALONE"), a status, and a baseUrl. Keep from the results:
- the id of the JIRA application: it is the jira_application_id required by
  link_requirements_to_jira (and the application_id accepted by list_relationships).
  If several Jira instances are connected, ask the user which one to use.
- the baseUrl of the CONFLUENCE instance: with a single active one it is resolved
  automatically; if several are connected, ask the user which instance the requirements
  live on and pass its baseUrl as base_url to search_requirements and
  link_requirements_to_jira.

If this tool fails because several organizations are accessible, call list_organizations, ask the user which organization to use, and retry with organization_id.

{{include:../fragments/jira-workflow.md}}
