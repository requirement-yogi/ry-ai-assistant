import {z} from "zod"
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js"
import {ryClient} from "../../core/api/ryClient.js"
import {projectOn, type SearchPage} from "../../core/dto.js"
import {RequirementSummarySchema} from "./dto.js"
import {registerTool, TOOL_NAMES, READS_REMOTE_STATE} from "../../core/toolRegistration/registerTool.js"
import {RyApiError} from "../../core/errors.js"

// The /rest/search response is a DTOSearchResult<DTORequirement>. A full DTORequirement is
// huge (storage data, recursive dependencies, rules…); project each result onto
// RequirementSummarySchema (./dto.js) to keep only the fields that matter for the linking use case,
// and keep the pagination envelope + query feedback as-is.
export function summarizeSearchPage(page: SearchPage) {
    const requirements = (page.results ?? []).map((requirement) => projectOn(RequirementSummarySchema, requirement))
    // Only claim a total we actually know. The API usually sends `total`; when it doesn't, this page
    // is the whole result set ONLY if there are no more pages (no hasNext). Reporting `returned` as
    // the total when hasNext is true would tell the model the query is well-scoped and stop it
    // paginating, silently missing the rest — so leave total_count out and let hasNext drive paging.
    const totalCount =
        typeof page.total === "number" ? page.total : page.hasNext ? undefined : requirements.length
    return {
        // Lead with the total: discovery is iterative and the model needs the volume to judge whether
        // the query is too broad or too narrow before drilling into the returned page.
        ...(totalCount !== undefined ? {total_count: totalCount} : {}),
        returned: requirements.length,
        offset: page.offset ?? undefined,
        limit: page.limit ?? undefined,
        hasNext: page.hasNext ?? undefined,
        // How the server understood the query, and any warnings — useful to double-check it.
        ...(page.humanReadable != null ? {humanReadable: page.humanReadable} : {}),
        ...(page.messageBean != null ? {messageBean: page.messageBean} : {}),
        requirements,
    }
}

// Use case 3, step 2: discover the RY requirements. Typically followed by list_relationships and
// link_requirements_to_jira.
export function registerSearchRequirementsTool(server: McpServer) {
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
        async ({query, space_key, offset, base_url}) => {
            const page = await ryClient().searchRequirements({
                query,
                spaceKey: space_key,
                offset,
                instanceBaseUrl: base_url
            })
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
}
