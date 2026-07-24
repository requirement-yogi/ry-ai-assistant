#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { registerBuildAdfTool } from "./tools/buildAdf.js"
import { registerEditPageTool } from "./tools/editPage.js"
import { registerJiraLinkTools } from "./tools/jiraLinks.js"
import { registerRequirementGalaxy } from "./tools/requirementGalaxy.js"

const server = new McpServer({
    name: "ry-ai-assistant",
    version: "1.0.0",
})

// Use case 1: create a new Confluence page from a requirements tree.
registerBuildAdfTool(server)
// Use case 2: analyze an existing page and reshape it so requirements are indexable.
registerEditPageTool(server)
// Use case 3: link requirements to Jira issues through the Requirement Yogi API.
registerJiraLinkTools(server)
// Visual exploration: renders a read-only Requirement Yogi knowledge graph in an MCP App.
registerRequirementGalaxy(server)

const transport = new StdioServerTransport()
await server.connect(transport)
