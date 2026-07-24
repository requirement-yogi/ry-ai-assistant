import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { searchRequirements } from "../api/ryClient.js"
import { GALAXY_APP_HTML } from "../ui/galaxy/galaxyApp.generated.js"
import { buildGalaxyPayload } from "./galaxyGraph.js"
import { SEARCH_SYNTAX } from "./searchSyntax.js"

const RESOURCE_URI = "ui://requirementyogi/requirement-galaxy"

// The app reads structuredContent, so the shape is a declared contract rather than an opaque blob.
// It also makes the SDK validate what we return before it ever reaches a host.
const GalaxyOutputSchema = {
  title: z.string(),
  query: z.string(),
  focusNodeId: z.string().optional(),
  totalCount: z.number(),
  truncated: z.boolean(),
  nodes: z.array(z.object({
    id: z.string(),
    type: z.enum(["requirement", "page", "jira"]),
    label: z.string(),
    key: z.string().optional(),
    text: z.string().optional(),
    status: z.string().optional(),
    properties: z.record(z.string(), z.string()).optional(),
    confluenceUrl: z.string().optional(),
    jiraUrl: z.string().optional(),
    rawId: z.union([z.string(), z.number()]).optional(),
  })),
  edges: z.array(z.object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    type: z.enum(["hierarchy", "dependency", "relationship", "jira"]),
    label: z.string().optional(),
  })),
  notes: z.array(z.string()),
}

export function registerRequirementGalaxy(server: McpServer) {
  registerAppResource(
    server,
    "Requirement Galaxy",
    RESOURCE_URI,
    {
      description: "Interactive graph explorer for Requirement Yogi requirements, relationships and Jira links.",
      _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
    },
    async () => ({
      contents: [{
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: GALAXY_APP_HTML,
        _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
      }],
    })
  )

  registerAppTool(
    server,
    "explore_requirement_galaxy",
    {
      title: "Explore Requirement Galaxy",
      description: `Open an interactive knowledge graph for a focused Requirement Yogi RQL search. Use this when the user wants to visually explore requirements, their hierarchy, dependencies, relationships, and linked Jira issues. The graph is built from the first 200 matching requirements and the relationship fields returned by Requirement Yogi; use a narrow query rather than trying to display an entire project. The app lets the user pan, zoom, inspect properties and open the source Confluence/Jira link.

YOU write the query, in the same Requirement Yogi RQL syntax as search_requirements — the full reference is below.

CRITICAL: the query is a structured "field operator value" expression, never a free-text search box, and it filters REQUIREMENTS only. A space, a page or a project is NOT a requirement key:
- a space goes in the space_key parameter (or \`space = 'KEY'\`), NEVER in \`key\`. Pass the key exactly as the user wrote it, including a leading \`~\` for a personal space ('~712020d9…' is a space key, not an operator followed by a value).
- a page goes in the query as \`page = 158302210\` (page id) or \`page ~ 'Title%'\` (title), NEVER in \`key\`.
So "the requirements of page 158302210 in space '~712020d9…'" is space_key = "~712020d9…" with query \`page = 158302210\` — not \`key = '712020d9…'\`.

GROUNDING: call list_searchable_fields(space) first when you are unsure which properties or relationships a space actually has.

${SEARCH_SYNTAX}`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Requirement Yogi RQL query (see the tool description), always a \"field operator value\" expression — never a bare term, a space key or a page id on its own. To show a whole page use \"page = 158302210\"; for a family of keys use \"key ~ 'FN-%'\". Keep it focused: one page, one feature or one key prefix."
          ),
        space_key: z
          .string()
          .optional()
          .describe("Restrict the search to one Confluence space. Pass the space key verbatim, including a leading ~ for a personal space (e.g. \"~712020d9b5d161a694434a8bd60d462d95346c\")."),
        base_url: z.string().optional().describe("Confluence base URL when several instances are connected"),
      },
      outputSchema: GalaxyOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ query, space_key, base_url }) => {
      try {
        const result = await searchRequirements({
          query,
          spaceKey: space_key,
          instanceBaseUrl: base_url,
          includeGraphData: true,
        })
        const galaxy = buildGalaxyPayload(result, query)
        return {
          // The text block is what the model reads; structuredContent is what the app draws.
          content: [{
            type: "text",
            text: `Requirement Galaxy ready: ${galaxy.nodes.length} node(s), ${galaxy.edges.length} connection(s), from ${galaxy.totalCount} matching requirement(s). Open the interactive view to explore it.`,
          }],
          structuredContent: galaxy,
        }
      } catch (error) {
        // An error result is the only channel the app has: log it to stderr too so the failure is
        // also visible in the MCP client log when the app itself cannot be opened.
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`[Requirement Galaxy] explore_requirement_galaxy failed for query ${JSON.stringify(query)}: ${reason}`)
        // Same self-correction path as search_requirements: the RY API answers a bad query with
        // 400 + "Syntax error at position N: ...", relayed verbatim so the RQL can be fixed.
        const looksLikeParseError = /\b400\b|syntax error|parse|position \d/i.test(reason)
        const guidance = looksLikeParseError
          ? "The query could not be parsed. Read the syntax error above, fix the RQL query, and call explore_requirement_galaxy again. Remember that a space key belongs in space_key and a page in `page = <id>`, never in `key`."
          : "The graph could not be built for a non-syntax reason (auth, connectivity, or instance selection). Fix the cause and retry."
        return {
          content: [{ type: "text", text: `explore_requirement_galaxy failed: ${reason}\n\n${guidance}` }],
          isError: true,
        }
      }
    }
  )
}
