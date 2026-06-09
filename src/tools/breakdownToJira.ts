import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { RequirementsTreeSchema, type RequirementNode } from "../schemas/requirements.js"

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8082"
const API_ACCESS_TOKEN = process.env.API_ACCESS_TOKEN ?? ""
const JIRA_APPLICATION_ID = 2

interface DTOBulkJiraIssueLinkItem {
  requirementKey: string
  spaceKey: string
  issueId: number
}

interface DTOBulkJiraIssueLinkRequest {
  jiraApplicationId: number
  relationshipId?: number
  links: DTOBulkJiraIssueLinkItem[]
}

/**
 * POST /jira-issue-links/bulk
 * Links all requirement keys to their Jira issues in a single batch call.
 */
async function bulkCreateJiraIssueLinks(request: DTOBulkJiraIssueLinkRequest): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/jira-issue-links/bulk?applicationId=${JIRA_APPLICATION_ID}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_ACCESS_TOKEN ? { Authorization: `Bearer ${API_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`)
  }
}

function flattenTree(
  nodes: RequirementNode[],
  parentKey: string | null = null
): Array<{ node: RequirementNode; parentKey: string | null }> {
  return nodes.flatMap((node) => [
    { node, parentKey },
    ...flattenTree(node.children, node.key),
  ])
}

const jiraIssueMappingSchema = z.array(
  z.object({
    requirement_key: z
      .string()
      .describe("The requirement key, e.g. AUTH-001"),
    jira_issue_id: z
      .number()
      .int()
      .describe("The Jira issue numeric ID (not the display key like RYC-42 — the internal integer id)"),
  })
)

export function registerBreakdownTool(server: McpServer) {
  server.registerTool(
    "breakdown_to_jira",
    {
      description: `Breaks down a requirements tree into Jira issues and links them to the Requirement Yogi backend.

This tool has two phases — call it twice:

PHASE 1 (no jira_issue_mapping provided):
  Instructs the LLM to:
  1. Let the user pick a Jira project (via getVisibleJiraProjects)
  2. Optionally create an Epic grouping all issues for this feature
  3. Create one Jira issue per requirement, top-down (parents before children)

PHASE 2 (jira_issue_mapping provided):
  The LLM passes back the { requirement_key → jira_issue_id } mapping.
  The tool calls POST /jira-issue-links/bulk on the Requirement Yogi backend
  to persist all links in a single batch call.

Call after submit_requirements, once the Confluence page has been created.`,
      inputSchema: {
        tree: z
          .record(z.string(), z.unknown())
          .describe("The requirements tree (complete JSON object) — same tree used for render/submit"),
        confluence_space_key: z
          .string()
          .describe(
            "The Confluence space key where the requirements page lives (e.g. 'RYC', 'PROJ'). " +
            "Used as spaceKey in each link item so requirements are resolved in the right space."
          ),
        relationship_id: z
          .number()
          .int()
          .optional()
          .describe("The relationship ID to use when creating the links. Omit to use the default relationship."),
        jira_issue_mapping: jiraIssueMappingSchema
          .optional()
          .describe(
            "Phase 2 only — array of { requirement_key, jira_issue_id } built after all Jira issues are created. " +
            "Providing this triggers the backend linking calls."
          ),
      },
    },
    async ({ tree, confluence_space_key, relationship_id, jira_issue_mapping }) => {
      const validation = RequirementsTreeSchema.safeParse(tree)
      if (!validation.success) {
        return {
          content: [{ type: "text", text: `Validation error: ${validation.error.message}` }],
          isError: true,
        }
      }

      const { project_name, description, requirements } = validation.data

      // ── Phase 2: mapping provided → single bulk call to backend ─────────────
      if (jira_issue_mapping && jira_issue_mapping.length > 0) {
        const summary = jira_issue_mapping
          .map((m) => `- \`${m.requirement_key}\` → issue #${m.jira_issue_id}`)
          .join("\n")

        try {
          await bulkCreateJiraIssueLinks({
            jiraApplicationId: JIRA_APPLICATION_ID,
            relationshipId: relationship_id,
            links: jira_issue_mapping.map((m) => ({
              requirementKey: m.requirement_key,
              spaceKey: confluence_space_key,
              issueId: m.jira_issue_id,
            })),
          })
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Jira issues were created but the backend linking call failed: ${err instanceof Error ? err.message : String(err)}\n\n` +
                  `Retry by calling breakdown_to_jira again with the same jira_issue_mapping.\n\n${summary}`,
              },
            ],
            isError: true,
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `All ${jira_issue_mapping.length} requirement(s) successfully linked to their Jira issues.\n\n${summary}`,
            },
          ],
        }
      }

      // ── Phase 1: instruct the LLM to create Jira issues ──────────────────────
      const flat = flattenTree(requirements)
      const requirementList = flat
        .map(
          ({ node, parentKey }) =>
            `- key: ${node.key} | title: ${node.title} | parent: ${parentKey ?? "none"}`
        )
        .join("\n")

      return {
        content: [
          {
            type: "text",
            text: `Break down the requirements below into Jira issues for project "${project_name}".

FEATURE DESCRIPTION: ${description}

REQUIREMENTS (top-down order, ${flat.length} total):
${requirementList}

STEPS — follow them in order:

1. CHOOSE PROJECT
   Call getVisibleJiraProjects to list available Jira projects.
   Present the list to the user and ask which project to use.

2. CREATE EPIC (optional)
   Ask the user: "Do you want to group all issues under an Epic named '${project_name}'?"
   If yes: create the Epic first via createJiraIssue (issuetype: "Epic", summary: "${project_name}").
   Note the Epic's numeric issue ID — you will need it as a parent for top-level issues.

3. CREATE ISSUES (top-down — parents before children)
   For each requirement in the list above:
   - issuetype: "Story" (or "Task" if the user prefers)
   - summary: "[KEY] Title"  (e.g. "[AUTH-001] User authentication")
   - description: include all requirement properties (Description, Acceptance criteria, Priority, …)
   - parent field:
       • if parent is not "none" → use the Jira numeric issue ID of the already-created parent issue
       • if parent is "none" AND an Epic was created → set parent to the Epic's numeric issue ID
       • if parent is "none" AND no Epic → leave parent empty
   Keep a local map of requirement_key → jira_issue_id as you create each issue.

4. CALL THIS TOOL AGAIN (Phase 2)
   Once ALL issues are created, call breakdown_to_jira with:
   - tree: (same JSON as now)
   - confluence_space_key: "${confluence_space_key}"
   - relationship_id: ${relationship_id ?? "(omit to use default)"}
   - jira_issue_mapping: the complete array of { requirement_key, jira_issue_id } pairs`,
          },
        ],
      }
    }
  )
}
