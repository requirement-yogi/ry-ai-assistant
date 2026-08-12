import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createJiraLinkBatch, formatLinkReport, LinkReportSchema } from "./jiraLinking.js"
import { registerTool, TOOL_NAMES, CREATES_LINKS } from "../../core/toolRegistration/registerTool.js"

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

// Use case 3, final step: create the links through the RY jira-bulk link service.
export function registerLinkRequirementsToJiraTool(server: McpServer) {
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
