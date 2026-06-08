import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { RequirementsTreeSchema } from "./schemas/requirements.js"
import { mdToAdf } from "./tools/md-to-adf.js"

const server = new McpServer({
  name: "prompt2requirements",
  version: "1.0.0",
})

// Indexing rules injected into render_requirements — the LLM must follow these exactly
const FORMAT_RULES = `
REQUIREMENT INDEXING RULES — MANDATORY:

Every requirement must appear in the Markdown with a \`req:KEY\` tag (e.g. \`req:AUTH-001\`).
The backtick notation is both the visual marker and what the backend parser looks for.

Three valid contexts for a \`req:KEY\` tag:

1. Paragraph — requirement with a full textual description:
   \`req:KEY\` The system shall... Priority: HIGH. Status: Draft.

2. Heading — requirement that titles a section detailed below:
   ## \`req:KEY\` — Section Title

3. Table cell — requirements that share a common structure:
   | Key | Description | Priority |
   |---|---|---|
   | \`req:KEY\` | Description | HIGH |

STRICT RULES:
- Each KEY appears exactly once — never repeat the same \`req:KEY\` in multiple places.
- Only the three contexts above are parsed; tags inside blockquotes, code blocks, or list items are ignored.
- Do NOT place a requirement outside one of these three contexts.

FREEDOM:
Outside these constraints, the document structure is entirely your choice.
Use headings, sections, tables, prose — whatever layout best communicates this specific requirement tree.`

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

KEY FORMAT RULES:
- Mandatory format: [A-Z]{2,8}-\\d{3} (e.g. WEBHOOK-001, AUTH-002)
- Prefix = meaningful abbreviation of the requirement domain (2-8 uppercase letters)
- Sequential numbering, unique across the entire tree
- Children may use a different prefix if their domain differs`,
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

server.registerTool(
  "refine_requirements",
  {
    description: `Refines an existing requirements tree by applying user feedback.

Two types of changes are possible:

1. REQUIREMENT CONTENT (text, properties, keys, structure) → modify the JSON then call render_requirements.
2. DOCUMENT ENRICHMENT (adding free text, notes, context around requirements) → can be done directly on the Markdown after rendering, without touching the JSON.`,
    inputSchema: {
      current_tree: z.record(z.string(), z.unknown()).describe("The current requirements tree (complete JSON object)"),
      feedback: z.string().describe("The feedback or changes requested by the user"),
    },
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
   → Modify the JSON and call render_requirements(tree) to regenerate the Markdown.
2. If the feedback is only about document enrichment (adding an example, a note, context):
   → Add the Markdown content directly around the existing requirements, without touching the JSON.
3. In all cases: every requirement must keep its \`req:KEY\` tag in a valid context (paragraph, heading, or table cell).`,
        },
      ],
    }
  }
)

server.registerTool(
  "render_requirements",
  {
    description: `Validates the requirements tree and instructs the LLM to generate the Markdown document.

The LLM chooses the layout that best represents the specific tree (headings, tables, prose, etc.).
Every requirement must include a \`req:KEY\` tag so the backend can parse and index it.

Call after analyze_prompt or refine_requirements.`,
    inputSchema: {
      tree: z.record(z.string(), z.unknown()).describe("The requirements tree (complete JSON object)"),
    },
  },
  async ({ tree }) => {
    const validation = RequirementsTreeSchema.safeParse(tree)
    if (!validation.success) {
      return {
        content: [{ type: "text", text: `Validation error: ${validation.error.message}` }],
        isError: true,
      }
    }

    const { project_name, description, created_at, requirements } = validation.data
    const date = new Date(created_at).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    })

    return {
      content: [
        {
          type: "text",
          text: `Generate a Markdown requirements document for the tree below.
You have full freedom over the document layout — choose the structure that best communicates this specific tree.
Follow the indexing rules exactly so the backend can parse and index each requirement.

PROJECT: ${project_name}
DESCRIPTION: ${description}
DATE: ${date}

JSON TREE:
${JSON.stringify(requirements, null, 2)}

${FORMAT_RULES}

Display the generated Markdown directly in your response (render it, do not wrap in a code block).
Then ask the user if they want to refine (via refine_requirements) or submit (via submit_requirements).`,
        },
      ],
    }
  }
)

server.registerTool(
  "submit_requirements",
  {
    description: `Converts the final Markdown document into an Atlassian Document Format (ADF) body with Requirement Yogi inline macros.

The conversion is done server-side: each \`req:KEY\` tag becomes a properly structured inlineExtension macro.
The resulting ADF is then ready to be published using other available tools (e.g. Atlassian MCP createConfluencePage).

Only call this tool once the user has confirmed they are satisfied with the document.`,
    inputSchema: {
      markdown: z.string().describe("The Markdown document produced by render_requirements"),
    },
  },
  async ({ markdown }) => {
    const adf = mdToAdf(markdown)

    const titleMatch = markdown.match(/^#\s+(.+)$/m)
    const title = titleMatch ? titleMatch[1].trim() : "Requirements"

    const adfString = JSON.stringify(adf)

    return {
      content: [
        {
          type: "text",
          text: `The Markdown has been converted to Atlassian Document Format (ADF).
Page title: "${title}"

ADF (JSON string, ready to pass as \`body\`):
${adfString}

NEXT STEP:

Option A — Confluence MCP tools available (e.g. createConfluencePage):
  Call createConfluencePage with:
    - title: "${title}"
    - body: <the ADF JSON string above>
    - contentFormat: "adf"
    - cloudId: ask the user if unknown
    - spaceId: ask the user if unknown
    - parentId: ask the user if they want to nest the page

Option B — No Confluence tools available:
  Provide the ADF JSON as a downloadable file named "requirements.adf.json" for the user.`,
        },
      ],
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
