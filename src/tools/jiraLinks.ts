import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  listOrganizations,
  listApplications,
  searchRequirements,
  listAllRelationships,
  createJiraLinks,
  type JiraBulkLink,
} from "../api/ryClient.js"
import { SEARCH_SYNTAX } from "./searchSyntax.js"

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

const WORKFLOW = `Full workflow for linking requirements to Jira issues (you orchestrate it):
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
5. Call link_requirements_to_jira with one entry per (requirement selection, issues, relationship).`

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

function summarizeRequirement(item: unknown): unknown {
  if (!item || typeof item !== "object") return item
  const record = item as Record<string, unknown>
  const summary: Record<string, unknown> = {}
  for (const field of REQUIREMENT_SUMMARY_FIELDS) {
    if (record[field] !== undefined && record[field] !== null) summary[field] = record[field]
  }
  return summary
}

function summarizeSearchPage(page: unknown): unknown {
  if (!page || typeof page !== "object" || !Array.isArray((page as Record<string, unknown>).results)) {
    return page
  }
  const record = page as Record<string, unknown>
  return {
    offset: record.offset,
    limit: record.limit,
    total: record.total,
    hasNext: record.hasNext,
    // How the server understood the query, and any warnings — useful to double-check it.
    ...(record.humanReadable != null ? { humanReadable: record.humanReadable } : {}),
    ...(record.messageBean != null ? { messageBean: record.messageBean } : {}),
    requirements: (record.results as unknown[]).map(summarizeRequirement),
  }
}

// POST /rest/jira-bulk/links answers with a DTOJiraBulkLinkResult:
// { linkedCount, skippedCount (link already existed), unauthorizedCount (issues the
// user cannot read) }.
function formatBulkLinkResult(result: unknown): string {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>
    if (typeof record.linkedCount === "number") {
      const parts = [`${record.linkedCount} link(s) created`]
      if (typeof record.skippedCount === "number" && record.skippedCount > 0) {
        parts.push(`${record.skippedCount} skipped (link already existed)`)
      }
      if (typeof record.unauthorizedCount === "number" && record.unauthorizedCount > 0) {
        parts.push(`${record.unauthorizedCount} unauthorized (the user cannot read those Jira issues)`)
      }
      return parts.join(", ")
    }
  }
  return JSON.stringify(result)
}

const SelectionSchema = z
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
  .describe("Which requirements this link applies to")

export function registerJiraLinkTools(server: McpServer) {
  server.registerTool(
    "list_organizations",
    {
      description: `USE THIS TOOL to discover the Requirement Yogi organizations the access token can see. You normally DON'T need it: with a single organization everything is resolved automatically. Use it only when another tool failed because several organizations are accessible.

Returns the organizations as JSON (id, name, displayName). Ask the user which organization to use — they can find their organization ID in the Requirement Yogi admin panel in Confluence or Jira — then pass it as organization_id to list_applications.

${WORKFLOW}`,
      inputSchema: {},
    },
    async () => {
      try {
        const organizations = await listOrganizations()
        return {
          content: [
            {
              type: "text",
              text: `Accessible organizations (JSON from the Requirement Yogi API):
${JSON.stringify(organizations)}

If there are several, ask the user which one to use (the organization ID is visible in the Requirement Yogi admin panel in Confluence or Jira), then pass it as organization_id to list_applications.`,
            },
          ],
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `list_organizations failed: ${(error as Error).message}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    "list_applications",
    {
      description: `USE THIS TOOL to discover the Confluence and Jira instances connected to Requirement Yogi, typically as the first step of linking requirements to Jira issues.

Returns the applications as JSON (all pages are fetched for you). Each item has an id, a type ("JIRA" | "CONFLUENCE" | "STANDALONE"), a status, and a baseUrl. Keep from the results:
- the id of the JIRA application: it is the jira_application_id required by
  link_requirements_to_jira (and the application_id accepted by list_relationships).
  If several Jira instances are connected, ask the user which one to use.
- the baseUrl of the CONFLUENCE instance: with a single active one it is resolved
  automatically; if several are connected, ask the user which instance the requirements
  live on and pass its baseUrl as base_url to search_requirements and
  link_requirements_to_jira.

If this tool fails because several organizations are accessible, call list_organizations, ask the user which organization to use, and retry with organization_id.

${WORKFLOW}`,
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
      try {
        const applications = await listApplications(organization_id)
        return {
          content: [
            {
              type: "text",
              text: `Connected applications (JSON from the Requirement Yogi API):
${JSON.stringify(applications)}

Keep the application IDs (jira_application_id) and base URLs (base_url) for the next steps.`,
            },
          ],
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `list_applications failed: ${(error as Error).message}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    "search_requirements",
    {
      description: `USE THIS TOOL when the user wants to find their Requirement Yogi requirements, typically as the first step of linking them to Jira issues.

Searches the requirements through the Requirement Yogi API. Each result is trimmed to the linking essentials: id, key, text, applicationId, containerId, variantId, status, canonicalURL, properties. Keep the id and the containerId/variantId: link_requirements_to_jira needs them. The response also echoes how the server understood the query (humanReadable) and any warnings (messageBean) — check them if the results look off.

YOU write the query: translate the user's request into the Requirement Yogi search syntax using the reference below. Results are paginated by 200: if hasNext is true, call again with offset = offset + limit.

CRITICAL: the query is a structured "field operator value" expression, never a free-text search box. A bare key or word is invalid — e.g. to find requirement BREW-F-01 send key = 'BREW-F-01', NOT BREW-F-01 on its own. When no field is specified, default to \`key\`.

${SEARCH_SYNTAX}

${WORKFLOW}`,
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
      try {
        const page = await searchRequirements({ query, spaceKey: space_key, offset, instanceBaseUrl: base_url })
        return {
          content: [
            {
              type: "text",
              text: `Requirements found (JSON from the Requirement Yogi API):
${JSON.stringify(summarizeSearchPage(page))}

Keep each requirement's id and its containerId/variantId: link_requirements_to_jira needs them.
If hasNext is true, call search_requirements again with offset = offset + limit for the next page.`,
            },
          ],
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `search_requirements failed: ${(error as Error).message}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    "list_relationships",
    {
      description: `USE THIS TOOL to discover the relationship types available in Requirement Yogi before linking requirements to Jira issues.

A link between a requirement and a Jira issue is qualified by a relationship (e.g. "implements", "is tested by"). Returns every relationship with its ID (all pages are fetched for you).

Present the choices to the user and let them pick the relationship to use, unless it is unambiguous.

${WORKFLOW}`,
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
      try {
        const relationships = await listAllRelationships(application_id)
        return {
          content: [
            {
              type: "text",
              text: `Available relationships (JSON from the Requirement Yogi API):
${JSON.stringify(relationships)}

Keep the relationship IDs: they are needed by link_requirements_to_jira.`,
            },
          ],
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `list_relationships failed: ${(error as Error).message}` }],
          isError: true,
        }
      }
    }
  )

  server.registerTool(
    "link_requirements_to_jira",
    {
      description: `USE THIS TOOL as the FINAL step when the user wants to link Requirement Yogi requirements to Jira issues.

Creates the links through the Requirement Yogi link service. Each entry links a SELECTION of requirements (explicit IDs, or a query with select_all) to a set of Jira issues with one relationship — e.g. "one issue per requirement" is one entry per pair, while "these 5 requirements all relate to this epic" is a single entry.

Requirements: use the IDs and container/variant IDs from search_requirements.
Jira issues: NUMERIC issue IDs (not PROJ-123 keys) — resolve them with the Atlassian MCP tools, which also handle finding or creating the issues.
Relationship: ID from list_relationships.

Only call it once the Jira issues exist and the user has confirmed the plan (issue structure AND relationship type).

${WORKFLOW}`,
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
      const created: string[] = []
      const failed: string[] = []

      for (const link of links) {
        const bulkLink: JiraBulkLink = {
          selection: {
            query: link.selection.query,
            containerId: link.selection.container_id,
            variantId: link.selection.variant_id,
            selectedRequirementIds: link.selection.selected_requirement_ids ?? [],
            excludedRequirementIds: link.selection.excluded_requirement_ids ?? [],
            selectAll: link.selection.select_all ?? false,
          },
          jiraApplicationId: link.jira_application_id,
          issueIds: link.issue_ids,
          relationshipId: link.relationship_id,
        }
        const requirementsLabel = bulkLink.selection.selectAll
          ? `query "${bulkLink.selection.query}"`
          : `requirements [${bulkLink.selection.selectedRequirementIds.join(", ")}]`
        const label = `${requirementsLabel} → issues [${bulkLink.issueIds.join(", ")}] (relationship ${bulkLink.relationshipId})`
        try {
          const result = await createJiraLinks(bulkLink, base_url)
          created.push(`${label}: ${formatBulkLinkResult(result)}`)
        } catch (error) {
          failed.push(`${label}: ${(error as Error).message}`)
        }
      }

      const report = [
        created.length
          ? `Completed ${created.length} link operation(s):\n${created.join("\n")}`
          : "No link operation completed.",
        failed.length ? `Failed ${failed.length} link operation(s):\n${failed.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n")

      return {
        content: [{ type: "text", text: report }],
        ...(created.length === 0 ? { isError: true } : {}),
      }
    }
  )
}
