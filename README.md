# Prompt2Requirements

An MCP (Model Context Protocol) server written in TypeScript that lets an LLM client (Claude Desktop, Claude Code, Cursor…) turn a user prompt into a structured requirements tree, refine it through conversation, and send it to a backend that generates a specification page (Confluence or any other tool).

## Prerequisites

- Node.js 18+
- npm
- Claude Desktop (or any MCP-compatible client)

## Installation

```bash
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
API_BASE_URL=http://localhost:8082
API_ACCESS_TOKEN=your-access-token
```

## Connecting to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "prompt2requirements": {
      "command": "node",
      "args": ["/path/to/Prompt2Requirements/dist/index.js"],
      "env": {
        "API_BASE_URL": "http://localhost:8082",
        "API_ACCESS_TOKEN": "your-access-token"
      }
    }
  }
}
```

Restart Claude Desktop. The 🔨 icon at the bottom of the input area confirms the tools are loaded.

## Usage

Describe a feature in plain language in Claude Desktop:

> "I want to specify a new feature for my connected coffee machine project. I'd like to add a webhook to trigger coffee preparation from an external automation."

Claude will then use the MCP tools to:

1. Break down the request into a structured JSON requirements tree
2. Display a Markdown preview with structured tables
3. Refine iteratively based on your feedback
4. Send the final page to the backend

## The 4 MCP Tools

| Tool | Role |
|---|---|
| `analyze_prompt` | Breaks down a prompt into a JSON requirements tree |
| `refine_requirements` | Applies user feedback to the JSON tree |
| `render_requirements` | Generates structured Markdown from the JSON |
| `submit_requirements` | Sends the final Markdown to the backend API |

## Generated Document Format

Each requirement is rendered as a table.

**Parent requirement (vertical table):**
```markdown
## Requirement title

| | |
| :--- | :--- |
| **Key** | WEBHOOK-001 |
| **Title** | Coffee brewing webhook |
| **Description** | Expose an HTTP endpoint... |
| **Priority** | Must |
```

**Child requirements (horizontal table):**
```markdown
| Key | Title | Description | Acceptance criteria |
| :--- | :--- | :--- | :--- |
| RECV-001 | Receive and validate | ... | 200 if accepted... |
| AUTH-001 | Authentication | ... | 401 if secret invalid |
```

Free Markdown content (code blocks, lists, notes) can be added around the tables.

## JSON Schema

```typescript
Property        = { label: string, value: string }
RequirementNode = {
  key: string,    // identifier: format [A-Z]{2,8}-\d{3}, e.g. WEBHOOK-001
  title: string,  // descriptive text
  properties: Property[],
  children: RequirementNode[]
}
RequirementsTree = {
  version: "1.0",
  project_name: string,
  description: string,
  created_at: string,  // ISO datetime
  requirements: RequirementNode[]
}
```

## Development

```bash
npm run dev      # Start the MCP server in dev mode (tsx, no build needed)
npm run build    # Compile TypeScript → dist/
npm run mock     # Start a local mock server on :3000 (saves .md files to output/)
```

## Logs

MCP server logs are available at:

```
~/Library/Logs/Claude/mcp-server-prompt2requirements.log
```

```bash
tail -f ~/Library/Logs/Claude/mcp-server-prompt2requirements.log
```

## Architecture

```
src/
├── index.ts              # MCP server — registers the 4 tools
├── auth/
│   └── keycloak.ts       # OAuth2 client credentials (if needed)
├── schemas/
│   └── requirements.ts   # Zod schema + TypeScript types
└── tools/
    ├── analyze.ts         # analyze tool constants
    ├── refine.ts          # refine tool constants
    ├── render.ts          # JSON → Markdown conversion
    └── submit.ts          # POST Markdown to the backend API
```
