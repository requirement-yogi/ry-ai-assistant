import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { getUpdateCheck, formatUpdateSummary } from "../updateCheck.js"
import { registerTool, TOOL_NAMES } from "./telemetry.js"

// check_for_updates — the ON-DEMAND "is this MCP up to date?" check. The automatic once-per-session
// surfacing happens elsewhere: withTelemetry (telemetry.ts) prepends an update banner to the first
// tool result of the session, so the user is informed even if this tool is never called. This tool
// stays available for an explicit "am I up to date?" question. Both share the cached check in
// updateCheck.ts, so there is at most one GitHub round-trip per session.

export function registerUpdatesTool(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.checkForUpdates,
    {
      description: `Check whether a newer version of this Requirement Yogi AI Assistant MCP server is available. You normally DON'T need to call this — the server automatically tells you on the first tool call of a session when an update is out. Use it only for an explicit "am I up to date?" question. It compares the running version against the latest GitHub release and reports the delta and what's new.`,
      inputSchema: {},
    },
    async () => {
      const check = await getUpdateCheck()
      return {
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
