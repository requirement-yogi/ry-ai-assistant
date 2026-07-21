import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ZodRawShapeCompat, AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js"
import type { ToolAnnotations, CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { sendTelemetry } from "../api/ryClient.js"
import { takeReadyUpdateNotice } from "../updateCheck.js"

// Single source of truth for the MCP tool names. Every registration and its telemetry ping read
// from here, so a name can never drift between the two, and `ToolName` turns any typo into a
// compile error instead of a silently wrong `feature` value.
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

// Mirrors the config object of McpServer.registerTool, kept generic over InputArgs so the
// inputSchema flows straight into the handler's parsed-args type.
type ToolConfig<InputArgs extends undefined | ZodRawShapeCompat | AnySchema> = {
  title?: string
  description?: string
  inputSchema?: InputArgs
  outputSchema?: ZodRawShapeCompat | AnySchema
  annotations?: ToolAnnotations
  _meta?: Record<string, unknown>
}

// Registers an MCP tool AND wires its telemetry in ONE call: the tool name is given once (from
// TOOL_NAMES) and used both for server.registerTool and for the best-effort POST /telemetry ping
// fired on every invocation (feature = the tool name). Because the name is passed once, the
// registered name and the telemetry `feature` can never disagree. The InputArgs generic flows the
// inputSchema into the handler's parsed args exactly like server.registerTool does.
export function registerTool<InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
  server: McpServer,
  name: ToolName,
  config: ToolConfig<InputArgs>,
  cb: ToolCallback<InputArgs>
) {
  return server.registerTool(name, config, withTelemetry(name, cb))
}

// Wraps a tool callback so every invocation:
//   1. fires a best-effort telemetry ping (feature = the tool name) — NOT awaited, never throws,
//      so it adds no latency and can't break the tool;
//   2. prepends the once-per-session "update available" banner to the FIRST tool result of the
//      session (via takeReadyUpdateNotice), so the user is told about a new version WITHOUT relying
//      on the LLM calling check_for_updates. It's non-blocking (returns undefined until the startup
//      GitHub check has resolved) and one-shot, so it never fires on more than one tool call — and
//      is skipped for check_for_updates itself to avoid duplicating its own report.
export function withTelemetry<Args extends undefined | ZodRawShapeCompat | AnySchema>(
  feature: ToolName,
  cb: ToolCallback<Args>
): ToolCallback<Args> {
  return (async (...args: unknown[]) => {
    void sendTelemetry(feature)
    const result = (await (cb as (...callbackArgs: unknown[]) => unknown)(...args)) as CallToolResult
    const notice = feature === TOOL_NAMES.checkForUpdates ? undefined : takeReadyUpdateNotice()
    if (notice && Array.isArray(result?.content)) {
      return { ...result, content: [{ type: "text", text: notice }, ...result.content] }
    }
    return result
  }) as unknown as ToolCallback<Args>
}
