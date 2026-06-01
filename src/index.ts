import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { RequirementsTreeSchema } from "./schemas/requirements.js"
import { validateAndRender } from "./tools/render.js"
import { submitMarkdown } from "./tools/submit.js"

const server = new McpServer({
  name: "prompt2requirements",
  version: "1.0.0",
})

// Format rules shared across tools — injected into instructions
const FORMAT_RULES = `
REQUIREMENT FORMAT RULES:
Every requirement must always appear in a table. This is mandatory for downstream parsing (Confluence, other apps).

VERTICAL table (parent requirement):
  | | |
  | :--- | :--- |
  | **Key** | PREFIX-001 |         ← 1st row: the requirement key
  | **Title** | Descriptive title | ← 2nd row: the title
  | **Prop** | value |              ← following rows: properties

HORIZONTAL table (child requirements):
  | Key | Title | Prop1 | Prop2 |   ← 1st col: key, 2nd: title, rest: properties
  | :--- | :--- | :--- | :--- |
  | PREFIX-001 | Title | ... | ... |

Outside of requirement tables, Markdown is free:
you may add code blocks, lists, notes, examples, callouts, intro text, etc.
These elements enrich the document without breaking requirement parsing.

What is forbidden: taking a requirement out of its table (free text, standalone heading, list item, etc.).
What is allowed: adding any free Markdown content around the tables.`

server.tool(
  "analyze_prompt",
  `Analyzes a user prompt and produces a structured requirements tree in JSON format.

Break down the request into hierarchical requirements (2 to 4 levels depending on complexity).

Recommended properties:
- "Description": detailed explanation
- "Acceptance criteria": validation conditions
- "Priority": Must / Should / Could / Won't

KEY FORMAT RULES:
- Mandatory format: [A-Z]{2,8}-\\d{3} (e.g. WEBHOOK-001, AUTH-002)
- Prefix = meaningful abbreviation of the requirement domain (2-8 uppercase letters)
- Sequential numbering, unique across the entire tree
- Children may use a different prefix if their domain differs

${FORMAT_RULES}`,
  {
    prompt: z.string().describe("The user request describing the feature or need to specify"),
    project_name: z.string().describe("Name of the project"),
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

KEY RULES:
- Format: [A-Z]{2,8}-\\d{3} mandatory (e.g. WEBHOOK-001, AUTH-002)
- Prefix = meaningful domain abbreviation (2-8 letters)
- Sequential numbering, unique across the entire tree
- Children may use a different prefix for a distinct domain

STEPS:
1. Produce the complete, valid JSON tree.
2. Call render_requirements(tree) — it generates the Markdown, do not write it manually.
3. Display the result and ask the user if they want to refine.`,
        },
      ],
    }
  }
)

server.tool(
  "refine_requirements",
  `Refines an existing requirements tree by applying user feedback.

Two types of changes are possible:

1. REQUIREMENT CONTENT (text, properties, keys, structure) → modify the JSON then call render_requirements.
2. DOCUMENT ENRICHMENT (adding free text, code blocks, lists, notes around the tables) → can be done directly on the Markdown after rendering.

${FORMAT_RULES}`,
  {
    current_tree: z.record(z.string(), z.unknown()).describe("The current requirements tree (complete JSON object)"),
    feedback: z.string().describe("The feedback or changes requested by the user"),
  },
  async ({ current_tree, feedback }) => {
    const validation = RequirementsTreeSchema.safeParse(current_tree)
    if (!validation.success) {
      return {
        content: [{ type: "text", text: `Error: the provided tree is invalid. ${validation.error.message}` }],
        isError: true,
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Apply the feedback to the requirements tree, then call render_requirements with the updated result.

FEEDBACK: ${feedback}

CURRENT TREE:
${JSON.stringify(current_tree, null, 2)}

STEPS:
1. If the feedback is about requirement content (text, properties, structure, keys):
   → Modify the JSON and call render_requirements(tree) to regenerate the base Markdown.
   → You may then enrich the Markdown (code blocks, lists, notes) around the tables if relevant.
2. If the feedback is only about document enrichment (adding an example, a note, context):
   → Add the Markdown content directly around the existing tables, without touching the JSON.
3. In all cases: requirements must remain in their tables, never as free text.`,
        },
      ],
    }
  }
)

server.tool(
  "render_requirements",
  `Converts a requirements JSON tree into structured Markdown with tables.

This is the ONLY tool allowed to produce requirements Markdown.
The table format is enforced server-side and cannot be changed.
Must be called after every analyze_prompt or refine_requirements.`,
  {
    tree: z.record(z.string(), z.unknown()).describe("The requirements tree (complete JSON object)"),
  },
  async ({ tree }) => {
    try {
      const markdown = validateAndRender(tree)
      return {
        content: [
          {
            type: "text",
            text: `Display the following document directly in your response (render the Markdown, do not wrap it in a code block):\n\n${markdown}\n\nAsk the user if they want to refine (via refine_requirements) or submit (via submit_requirements).`,
          },
        ],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Render error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
    }
  }
)

server.tool(
  "submit_requirements",
  `Sends the final Markdown to the backend API to generate the specification page.

Only call this tool once the user has confirmed they are satisfied.
Pass ONLY the Markdown produced by render_requirements — never hand-written Markdown.`,
  {
    markdown: z.string().describe("The Markdown content produced by render_requirements"),
  },
  async ({ markdown }) => {
    const result = await submitMarkdown(markdown)
    return {
      content: [{ type: "text", text: result.message }],
      isError: !result.success,
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
