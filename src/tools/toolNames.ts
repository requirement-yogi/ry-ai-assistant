// Single source of truth for the MCP tool names. Every registration, its telemetry ping and its
// prompt file are keyed from here, so a name can never drift between the three, and `ToolName`
// turns any typo into a compile error instead of a silently wrong `feature` value or a missing
// description.
//
// Its own module (rather than living in registry.ts) so src/prompts/descriptions.ts can check its
// generated map against ToolName without importing the registry that consumes it.
//
// Adding a tool = add it here AND add src/prompts/tools/<name>.md; forgetting either one is a
// compile error in src/prompts/descriptions.ts.

export const TOOL_NAMES = {
  checkForUpdates: "check_for_updates",
  buildRequirementsAdf: "build_requirements_adf",
  editPageRequirements: "edit_page_requirements",
  listOrganizations: "list_organizations",
  listApplications: "list_applications",
  listSearchableFields: "list_searchable_fields",
  searchRequirements: "search_requirements",
  listRelationships: "list_relationships",
  linkRequirementsToJira: "link_requirements_to_jira",
} as const

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES]
