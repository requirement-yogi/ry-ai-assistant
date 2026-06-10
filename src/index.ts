import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { registerBuildAdfTool } from "./tools/buildAdf.js"
import { registerEditPageTool } from "./tools/editPage.js"

const server = new McpServer({
    name: "ry-ai-assistant",
    version: "1.0.0",
})

// Use case 1: create a new Confluence page from a requirements tree.
registerBuildAdfTool(server)
// Use case 2: analyze an existing page and reshape it so requirements are indexable.
registerEditPageTool(server)

const transport = new StdioServerTransport()
await server.connect(transport)
