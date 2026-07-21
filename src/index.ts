#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { registerBuildAdfTool } from "./tools/buildAdf.js"
import { registerEditPageTool } from "./tools/editPage.js"
import { registerJiraLinkTools } from "./tools/jiraLinks.js"
import { registerUpdatesTool } from "./tools/updates.js"
import { startUpdateCheck } from "./updateCheck.js"
import { VERSION } from "./version.generated.js"

const server = new McpServer(
    {
        name: "ry-ai-assistant",
        version: VERSION,
    },
    {
        // The update check runs automatically: the server prepends an "update available" banner to
        // the first tool result of the session (see withTelemetry). This just documents that
        // behaviour for the LLM so it acts on the banner rather than treating it as tool output.
        instructions:
            "When a tool result begins with a '[Requirement Yogi AI Assistant — update available]' " +
            "notice, tell the user a newer version is out and summarize what's new, then continue " +
            "with their request. You can also call check_for_updates on demand to re-check.",
    }
)

// Start the GitHub release check now so its result is ready by the first tool call, where
// withTelemetry surfaces it once per session (no need for the LLM to call check_for_updates).
startUpdateCheck()

// Session housekeeping: on-demand "is this MCP up to date?" check (auto-surfaced via withTelemetry).
registerUpdatesTool(server)
// Use case 1: create a new Confluence page from a requirements tree.
registerBuildAdfTool(server)
// Use case 2: analyze an existing page and reshape it so requirements are indexable.
registerEditPageTool(server)
// Use case 3: link requirements to Jira issues through the Requirement Yogi API.
registerJiraLinkTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)
