import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { registerAnalyzeTool } from "./tools/analyze.js"
import { registerRefineTool } from "./tools/refine.js"
import { registerRenderTool } from "./tools/render.js"
import { registerSubmitTool } from "./tools/submit.js"

const server = new McpServer({
    name: "ry-ai-assistant",
    version: "1.0.0",
})

registerAnalyzeTool(server)
registerRefineTool(server)
registerRenderTool(server)
registerSubmitTool(server)

const transport = new StdioServerTransport()
await server.connect(transport)
