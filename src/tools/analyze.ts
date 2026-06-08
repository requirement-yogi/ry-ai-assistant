import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

const KEY_FORMAT_RULES = `
KEY FORMAT RULES:
- Mandatory format: [A-Z]{2,8}-\\d{3} (e.g. WEBHOOK-001, AUTH-002)
- Prefix = meaningful abbreviation of the requirement domain (2-8 uppercase letters)
- Sequential numbering, unique across the entire tree
- Children may use a different prefix if their domain differs`

export function registerAnalyzeTool(server: McpServer) {
  server.registerTool(
    "analyze_prompt",
    {
      description: `USE THIS TOOL when the user wants to write, create, specify, or document requirements for a software feature or project.
This is the entry point of the requirements workflow: analyze_prompt → render_requirements → submit_requirements.

This MCP handles the requirements-specific work: structuring the tree, formatting the document, and generating
the ADF body with Requirement Yogi inline macros for each requirement.
The actual Confluence page creation is then handled by other available tools (e.g. Atlassian MCP).

Analyzes the user's request and produces a structured requirements tree in JSON format.

Break down the request into hierarchical requirements (2 to 4 levels depending on complexity).

Recommended properties:
- "Description": detailed explanation
- "Acceptance criteria": validation conditions
- "Priority": Must / Should / Could / Won't
${KEY_FORMAT_RULES}`,
      inputSchema: {
        prompt: z.string().describe("The user request describing the feature or need to specify"),
        project_name: z.string().describe("Name of the project"),
      },
    },
    async ({ prompt, project_name }) => {
      const now = new Date().toISOString()
      return {
        content: [
          {
            type: "text",
            text: `Generate a requirements JSON tree for the following request, then immediately call render_requirements with the result.

PROJECT: ${project_name}
REQUEST: ${prompt}

JSON SCHEMA (mandatory):
{
  "version": "1.0",
  "project_name": "${project_name}",
  "description": "<feature summary in 1-2 sentences>",
  "created_at": "${now}",
  "requirements": [
    {
      "key": "<PREFIX-NNN>",
      "title": "<descriptive title>",
      "properties": [
        { "label": "Description", "value": "<detail>" },
        { "label": "Acceptance criteria", "value": "<conditions>" },
        { "label": "Priority", "value": "Must | Should | Could | Won't" }
      ],
      "children": [ ...same structure recursively if needed... ]
    }
  ]
}
${KEY_FORMAT_RULES}

STEPS:
1. Produce the complete, valid JSON tree.
2. Call render_requirements(tree) — it generates the Markdown, do not write it manually.
3. Display the result and ask the user if they want to refine.`,
          },
        ],
      }
    }
  )
}
