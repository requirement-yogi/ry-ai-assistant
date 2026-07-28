import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ryClient } from "../api/ryClient.js"
import { ApplicationSchema, OrganizationSchema, RelationshipSchema, type Requirement, type SearchPage } from "../api/dto.js"
import { listSearchableFields, SearchableFieldsSchema } from "../services/schemaGrounding.js"
import { createJiraLinkBatch, formatLinkReport, LinkReportSchema } from "../services/jiraLinking.js"
import { registerTool, TOOL_NAMES, READS_REMOTE_STATE, CREATES_LINKS } from "./registry.js"
import { RyApiError } from "../errors.js"

// Use case 3: link Requirement Yogi requirements to Jira issues.
//
// The workflow is orchestrated by the client LLM:
//   1. list_applications         → discover the connected instances (RY standalone API);
//      (list_organizations)        needed first only when the token spans several organizations
//   2. search_requirements       → discover the requirements (RY Confluence API)
//   3. Atlassian MCP             → find existing Jira issues, or create them AFTER the
//                                  user chose how to structure them (delegated, not here)
//   4. list_relationships        → discover the available relationship types (RY standalone API)
//   5. link_requirements_to_jira → create the links (RY jira-bulk link service)
//
// The descriptions the LLM reads live in src/prompts/tools/<tool name>.md; the workflow above is
// spelled out for it once in src/prompts/fragments/jira-workflow.md and included by each of them.

// The /rest/search response is a DTOSearchResult<DTORequirement>. A full DTORequirement is
// huge (storage data, recursive dependencies, rules…); trim each result to the fields that
// matter for the linking use case, and keep the pagination envelope + query feedback.
const REQUIREMENT_SUMMARY_FIELDS = [
  "id",
  "key",
  "text",
  "applicationId",
  "containerId",
  "variantId",
  "status",
  "canonicalURL",
  "properties",
] as const

// Nulls are dropped as well as undefined: the DTO accepts null for every optional field (the API
// sends both), and an explicit `"key": null` is noise in a tool result.
function summarizeRequirement(requirement: Requirement): Record<string, unknown> {
  const summary: Record<string, unknown> = {}
  for (const field of REQUIREMENT_SUMMARY_FIELDS) {
    const value = requirement[field]
    if (value !== undefined && value !== null) summary[field] = value
  }
  return summary
}

export function summarizeSearchPage(page: SearchPage) {
  const requirements = (page.results ?? []).map(summarizeRequirement)
  // Only claim a total we actually know. The API usually sends `total`; when it doesn't, this page
  // is the whole result set ONLY if there are no more pages (no hasNext). Reporting `returned` as
  // the total when hasNext is true would tell the model the query is well-scoped and stop it
  // paginating, silently missing the rest — so leave total_count out and let hasNext drive paging.
  const totalCount =
    typeof page.total === "number" ? page.total : page.hasNext ? undefined : requirements.length
  return {
    // Lead with the total: discovery is iterative and the model needs the volume to judge whether
    // the query is too broad or too narrow before drilling into the returned page.
    ...(totalCount !== undefined ? { total_count: totalCount } : {}),
    returned: requirements.length,
    offset: page.offset ?? undefined,
    limit: page.limit ?? undefined,
    hasNext: page.hasNext ?? undefined,
    // How the server understood the query, and any warnings — useful to double-check it.
    ...(page.humanReadable != null ? { humanReadable: page.humanReadable } : {}),
    ...(page.messageBean != null ? { messageBean: page.messageBean } : {}),
    requirements,
  }
}

export const SelectionSchema = z
  .object({
    query: z
      .string()
      .optional()
      .describe("RY search query selecting the requirements (required when select_all is true)"),
    container_id: z.number().int().describe("Container ID the requirements belong to (from search_requirements results)"),
    variant_id: z.number().int().describe("Variant ID of the requirements (from search_requirements results)"),
    selected_requirement_ids: z
      .array(z.number().int())
      .optional()
      .describe("Requirement IDs explicitly selected"),
    excluded_requirement_ids: z
      .array(z.number().int())
      .optional()
      .describe("Requirement IDs explicitly excluded (useful with select_all)"),
    select_all: z.boolean().optional().describe("Select every requirement matched by query (default false)"),
  })
  // select_all means "link every requirement the query matches", so the query is what defines the
  // set — without it there is nothing to select. Fail fast here rather than at the RY API call.
  .refine((selection) => !selection.select_all || (selection.query != null && selection.query.trim() !== ""), {
    message: "query is required (and must be non-empty) when select_all is true",
    path: ["query"],
  })
  // The mirror image: when NOT select_all the set is the explicit ID list, so it must be non-empty.
  // Otherwise the RY link service receives selectAll:false with an empty ID list, silently links
  // nothing (the query is ignored server-side in this mode), and reports a misleading success.
  .refine((selection) => selection.select_all || (selection.selected_requirement_ids?.length ?? 0) > 0, {
    message: "selected_requirement_ids must be non-empty unless select_all is true (use select_all with a query to link every match)",
    path: ["selected_requirement_ids"],
  })
  .describe("Which requirements this link applies to")

export function registerJiraLinkTools(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.listOrganizations,
    {
      annotations: READS_REMOTE_STATE,
      inputSchema: {},
      outputSchema: { organizations: z.array(OrganizationSchema) },
    },
    async () => {
      const organizations = await ryClient().listOrganizations()
      return {
        structuredContent: { organizations },
        content: [
          {
            type: "text",
            text: `Accessible organizations (JSON from the Requirement Yogi API):
${JSON.stringify(organizations)}

If there are several, ask the user which one to use (the organization ID is visible in the Requirement Yogi admin panel in Confluence or Jira), then pass it as organization_id to list_applications.`,
          },
        ],
      }
    }
  )

  registerTool(
    server,
    TOOL_NAMES.listApplications,
    {
      annotations: READS_REMOTE_STATE,
      outputSchema: { applications: z.array(ApplicationSchema) },
      inputSchema: {
        organization_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Organization ID (from list_organizations); only needed when the token can see several organizations — ask the user which one to use"
          ),
      },
    },
    async ({ organization_id }) => {
      const applications = await ryClient().listApplications(organization_id)
      return {
        structuredContent: { applications },
        content: [
          {
            type: "text",
            text: `Connected applications (JSON from the Requirement Yogi API):
${JSON.stringify(applications)}

Keep the application IDs (jira_application_id) and base URLs (base_url) for the next steps.`,
          },
        ],
      }
    }
  )

  registerTool(
    server,
    TOOL_NAMES.listSearchableFields,
    {
      annotations: READS_REMOTE_STATE,
      outputSchema: SearchableFieldsSchema.shape,
      inputSchema: {
        space: z.string().min(1).describe("The Confluence space key whose searchable fields you want"),
        application_id: z
          .number()
          .int()
          .optional()
          .describe(
            "RY application identifier for the relationships lookup; required unless the token is already scoped to one application"
          ),
        base_url: z
          .string()
          .optional()
          .describe(
            "Base URL of the Confluence instance (from list_applications); only needed when several Confluence instances are connected"
          ),
      },
    },
    async ({ space, application_id, base_url }) => {
      const fields = await listSearchableFields({ spaceKey: space, applicationId: application_id, instanceBaseUrl: base_url })
      return {
        structuredContent: fields,
        content: [
          {
            type: "text",
            text: `Searchable fields for space "${space}" (JSON from the Requirement Yogi API):
${JSON.stringify(fields)}

Use ONLY these identifiers when writing the query for search_requirements (plus the core fields key/text/page/status/jira). Prefix them per the syntax: @property, ext@property, from@/to@/jira@relationship.`,
          },
        ],
      }
    }
  )

  registerTool(
    server,
    TOOL_NAMES.searchRequirements,
    {
      annotations: READS_REMOTE_STATE,
      // No outputSchema here on purpose: the MCP spec asks a tool that returns structuredContent to
      // ALSO serialise it into a text block for older clients, so declaring one would send a page of
      // up to 200 requirements twice. The small, bounded discovery tools pay that cost happily; this
      // one doesn't.
      // A 400 here is almost always a malformed RQL query. RyApiError already relays the server's
      // "Syntax error at position N: ..." verbatim and says to fix the input; what the generic
      // taxonomy can't know is that the cure for an invented field name is schema grounding.
      errorGuidance: (error) =>
        error instanceof RyApiError && error.status === 400
          ? "If the error points at a field, property or relationship name, call list_searchable_fields(space) to get the real identifiers of that space before rewriting the query."
          : undefined,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "The search query in the Requirement Yogi search syntax (see the tool description), always a \"field operator value\" expression — never a bare term. To find a key like BREW-F-01 use \"key = 'BREW-F-01'\" (exact) or \"key ~ 'BREW-F-01%'\" (prefix), not BREW-F-01 alone. E.g. \"key ~ 'FN-%' AND @Priority = 'High'\""
          ),
        space_key: z.string().optional().describe("Restrict the search to one Confluence space"),
        offset: z.number().int().optional().describe("Pagination offset (results come by pages of 200)"),
        base_url: z
          .string()
          .optional()
          .describe(
            "Base URL of the Confluence instance (from list_applications); only needed when several Confluence instances are connected — ask the user which one to use"
          ),
      },
    },
    async ({ query, space_key, offset, base_url }) => {
      const page = await ryClient().searchRequirements({ query, spaceKey: space_key, offset, instanceBaseUrl: base_url })
      return {
        content: [
          {
            type: "text",
            text: `Requirements found (JSON from the Requirement Yogi API):
${JSON.stringify(summarizeSearchPage(page))}

total_count (when present) is the full number of matches; requirements is just this page. If it's too broad or too narrow, refine the query and search again.
Keep each requirement's id and its containerId/variantId: link_requirements_to_jira needs them.
Do NOT assume this page is complete from its size alone: if hasNext is true there are more matches — call search_requirements again with offset = offset + limit for the next page.`,
          },
        ],
      }
    }
  )

  registerTool(
    server,
    TOOL_NAMES.listRelationships,
    {
      annotations: READS_REMOTE_STATE,
      outputSchema: { relationships: z.array(RelationshipSchema) },
      inputSchema: {
        application_id: z
          .number()
          .int()
          .optional()
          .describe(
            "RY application identifier; required unless the access token is already scoped to a single application"
          ),
      },
    },
    async ({ application_id }) => {
      const relationships = await ryClient().listAllRelationships(application_id)
      return {
        structuredContent: { relationships },
        content: [
          {
            type: "text",
            text: `Available relationships (JSON from the Requirement Yogi API):
${JSON.stringify(relationships)}

Keep the relationship IDs: they are needed by link_requirements_to_jira.`,
          },
        ],
      }
    }
  )

  registerTool(
    server,
    TOOL_NAMES.linkRequirementsToJira,
    {
      annotations: CREATES_LINKS,
      outputSchema: LinkReportSchema.shape,
      inputSchema: {
        links: z
          .array(
            z.object({
              selection: SelectionSchema,
              jira_application_id: z
                .number()
                .int()
                .describe("ID of the Jira application (the Jira instance linked to Requirement Yogi)"),
              issue_ids: z
                .array(z.number().int())
                .min(1)
                .describe("Numeric Jira issue IDs to link to the selected requirements"),
              relationship_id: z.number().int().describe("Relationship ID (from list_relationships)"),
            })
          )
          .min(1)
          .describe("The link operations to perform, one entry per (requirement selection, issues, relationship)"),
        base_url: z
          .string()
          .optional()
          .describe(
            "Base URL of the Confluence instance (from list_applications); only needed when several Confluence instances are connected — ask the user which one to use"
          ),
      },
    },
    async ({ links, base_url }) => {
      const report = await createJiraLinkBatch(links, { instanceBaseUrl: base_url })
      return {
        structuredContent: report,
        content: [{ type: "text", text: formatLinkReport(report) }],
        // Only an all-or-nothing failure is an error: a partially successful batch DID create
        // links, and reporting it as an error would push the model to retry them.
        ...(report.completed === 0 && report.failed > 0 ? { isError: true } : {}),
      }
    }
  )
}
