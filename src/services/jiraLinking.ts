// Jira linking — the orchestration behind link_requirements_to_jira.
//
// Two jobs, both of which are business logic rather than protocol plumbing, which is why they sit
// here and not in the tool file:
//   1. translate the MCP-facing vocabulary (snake_case, the shape the LLM fills in) into the RY
//      API's DTORequirementSelection — the anti-corruption layer between the two contracts;
//   2. run the batch, letting each operation succeed or fail on its own.
//
// Partial failure is the interesting case. A batch is often "one operation per requirement", so
// aborting on the first rejection would strand the links already created and give the model no way
// to tell what happened. Instead every operation is reported individually.

import { z } from "zod"
import { ryClient, type JiraBulkLink, type RyClient } from "../api/ryClient.js"
import type { BulkLinkResult } from "../api/dto.js"

// The one endpoint this service needs, so a test can drive the batch loop (including partial
// failure) against a fake instead of the real link service.
export type JiraLinkingApi = Pick<RyClient, "createJiraLinks">

export type LinkBatchOptions = {
  instanceBaseUrl?: string
  api?: JiraLinkingApi
}

// POST /rest/jira-bulk/links answers with a DTOJiraBulkLinkResult: { linkedCount, skippedCount
// (the link already existed), unauthorizedCount (issues the user cannot read) }. Those three
// counts are the whole outcome of an operation, so they get rendered as one sentence.
export function formatBulkLinkResult(result: BulkLinkResult): string {
  if (typeof result.linkedCount !== "number") {
    // No linkedCount in the body. An EMPTY body is a success the server didn't detail (some
    // deployments answer 204/empty) — say so plainly; any other shape is unexpected, so fall back
    // to the raw payload rather than inventing a count.
    return Object.keys(result).length === 0
      ? "Link operation completed (Requirement Yogi returned no counts)."
      : JSON.stringify(result)
  }
  const parts = [`${result.linkedCount} link(s) created`]
  if (result.skippedCount) parts.push(`${result.skippedCount} skipped (link already existed)`)
  if (result.unauthorizedCount) {
    parts.push(`${result.unauthorizedCount} unauthorized (the user cannot read those Jira issues)`)
  }
  return parts.join(", ")
}

// One link operation as the LLM supplies it (see the inputSchema of link_requirements_to_jira).
export type LinkRequest = {
  selection: {
    query?: string
    container_id: number
    variant_id: number
    selected_requirement_ids?: number[]
    excluded_requirement_ids?: number[]
    select_all?: boolean
  }
  jira_application_id: number
  issue_ids: number[]
  relationship_id: number
}

export const LinkReportSchema = z.object({
  completed: z.number().int().describe("How many link operations succeeded"),
  failed: z.number().int().describe("How many link operations failed"),
  operations: z
    .array(
      z.object({
        selection: z.string().describe("Which requirements and issues this operation covered"),
        ok: z.boolean().describe("Whether the operation succeeded"),
        result: z.string().describe("The counts reported by Requirement Yogi, or the failure reason"),
      })
    )
    .describe("One entry per requested operation, in the order they were requested"),
})

export type LinkReport = z.infer<typeof LinkReportSchema>

// MCP vocabulary → RY API vocabulary.
function toBulkLink(request: LinkRequest): JiraBulkLink {
  return {
    selection: {
      query: request.selection.query,
      containerId: request.selection.container_id,
      variantId: request.selection.variant_id,
      selectedRequirementIds: request.selection.selected_requirement_ids ?? [],
      excludedRequirementIds: request.selection.excluded_requirement_ids ?? [],
      selectAll: request.selection.select_all ?? false,
    },
    jiraApplicationId: request.jira_application_id,
    issueIds: request.issue_ids,
    relationshipId: request.relationship_id,
  }
}

export function describeSelection(link: JiraBulkLink): string {
  const requirements = link.selection.selectAll
    ? `query "${link.selection.query}"`
    : `requirements [${link.selection.selectedRequirementIds.join(", ")}]`
  return `${requirements} → issues [${link.issueIds.join(", ")}] (relationship ${link.relationshipId})`
}

export async function createJiraLinkBatch(
  requests: LinkRequest[],
  options: LinkBatchOptions = {}
): Promise<LinkReport> {
  const { instanceBaseUrl, api = ryClient() } = options

  // Sequential ON PURPOSE, not merely failure-isolated. When base_url is omitted the FIRST call
  // resolves the Confluence instance (and organization) and caches it on the client; running the
  // batch concurrently would start every operation before that cache is populated, firing N×
  // redundant /applications + /organizations round-trips AND N concurrent POSTs to the link
  // service at once (a rate-limit risk). Awaiting each in turn lets the rest hit the warm cache.
  const operations: LinkReport["operations"] = []
  for (const request of requests) {
    const link = toBulkLink(request)
    const selection = describeSelection(link)
    // A deliberate catch (one of two outside registry.ts, alongside sendTelemetry): it keeps the
    // batch going rather than swallowing the failure — the reason is reported back per operation.
    try {
      const result = await api.createJiraLinks(link, instanceBaseUrl)
      operations.push({ selection, ok: true, result: formatBulkLinkResult(result) })
    } catch (error) {
      operations.push({ selection, ok: false, result: (error as Error).message })
    }
  }

  return {
    completed: operations.filter((operation) => operation.ok).length,
    failed: operations.filter((operation) => !operation.ok).length,
    operations,
  }
}

export function formatLinkReport(report: LinkReport): string {
  const line = (operation: LinkReport["operations"][number]) => `- ${operation.selection}: ${operation.result}`
  const succeeded = report.operations.filter((operation) => operation.ok)
  const failed = report.operations.filter((operation) => !operation.ok)

  return [
    succeeded.length
      ? `Completed ${succeeded.length} link operation(s):\n${succeeded.map(line).join("\n")}`
      : "No link operation completed.",
    failed.length ? `Failed ${failed.length} link operation(s):\n${failed.map(line).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}
