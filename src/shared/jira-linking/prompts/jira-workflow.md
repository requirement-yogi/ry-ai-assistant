Full workflow for linking requirements to Jira issues (you orchestrate it):
1. Call list_applications to discover the Confluence and Jira instances connected to
   Requirement Yogi (each item has an id, a type "JIRA" | "CONFLUENCE" | "STANDALONE",
   a status, and a baseUrl). If it fails because several organizations are accessible,
   call list_organizations, ask the user which organization to use (the organization ID
   is visible in the Requirement Yogi admin panel in Confluence or Jira), then retry
   with organization_id. Then:
   - JIRA items give the jira_application_id needed for linking; if several Jira instances
     are connected, ask the user which one to use.
   - CONFLUENCE items give the base URL: with a single active Confluence instance it is
     resolved automatically; if several are connected, ask the user which instance the
     requirements live on and pass its base URL as base_url to search_requirements and
     link_requirements_to_jira.
2. Call search_requirements with a query in the RY search syntax to discover the Requirement
   Yogi requirements: their IDs, and the containerId/variantId needed later to build the
   link selection.
3. Find or create the Jira issues with the Atlassian MCP tools (e.g. searchJiraIssuesUsingJql,
   createJiraIssue). BEFORE creating any issue, ask the user how they want the Jira side
   structured: one issue per requirement or grouped? Epics, sub-tasks or plain issues?
   Which project, issue type, parent, sprint? Do NOT create anything until the user has
   confirmed the whole plan. Linking needs the NUMERIC Jira issue IDs, not the PROJ-123 keys.
4. Call list_relationships and let the user pick which relationship type the links should use
   (ask unless it is unambiguous).
5. Call link_requirements_to_jira with one entry per (requirement selection, issues, relationship).
