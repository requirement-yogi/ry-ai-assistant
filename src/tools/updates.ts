import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { getUpdateCheck, formatUpdateSummary } from "../updateCheck.js"
import { UpdateCheckSchema } from "../api/githubReleases.js"
import { registerTool, TOOL_NAMES, READS_REMOTE_STATE } from "./registry.js"

// check_for_updates — the ON-DEMAND "is this MCP up to date?" check. The automatic once-per-session
// surfacing happens elsewhere: withTelemetry (registry.ts) prepends an update banner to the first
// tool result of the session, so the user is informed even if this tool is never called. This tool
// stays available for an explicit "am I up to date?" question. Both share the cached check in
// updateCheck.ts, so there is at most one GitHub round-trip per session.

export function registerUpdatesTool(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.checkForUpdates,
    { annotations: READS_REMOTE_STATE, inputSchema: {}, outputSchema: UpdateCheckSchema.shape },
    async () => {
      const check = await getUpdateCheck()
      return {
        structuredContent: check,
        content: [
          {
            type: "text",
            text: `${formatUpdateSummary(check)}\n\nRaw result (JSON): ${JSON.stringify(check)}`,
          },
        ],
      }
    }
  )
}
