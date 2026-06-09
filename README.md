# Prompt2Requirements — MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets any LLM client turn a plain-language prompt into a structured requirements tree, refine it through conversation, publish it as a Confluence page, and link each requirement to a Jira issue — all without leaving your chat interface.

**The LLM does the thinking.** The MCP server provides the schema, validates the JSON, and handles the API calls. No server-side LLM calls, no cloud dependency.

---

## Prerequisites

- [Node.js](https://nodejs.org) 18 or later
- npm (bundled with Node.js)
- A [Requirement Yogi](https://www.requirement-yogi.com) account with API credentials
- An MCP-compatible LLM client (see [Connecting your client](#connecting-your-client) below)

---

## Installation

### Option A — Clone and build (recommended)

```bash
git clone https://github.com/requirement-yogi/prompt2requirements.git
cd prompt2requirements
npm install
npm run build
```

The compiled server is now at `dist/index.js`.

### Option B — Run directly with `npx tsx` (no build step)

If you prefer to skip the build, you can point your client to the source file directly using `tsx`:

```bash
npm install   # install dependencies only
```

Then use `npx tsx /path/to/prompt2requirements/src/index.ts` as the command in your client config (see below).

---

## Configuration

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

```env
API_BASE_URL=https://your-requirement-yogi-instance.com
API_ACCESS_TOKEN=ryc_v1_your_token_here
```

> You can also pass these values directly as `env` in your client config instead of using a `.env` file (see client examples below).

---

## Connecting your client

The server communicates over **stdio** — the standard MCP transport. Every MCP-compatible client uses a JSON configuration file. Replace `/path/to/prompt2requirements` with the actual absolute path where you cloned the repo.

### Claude Desktop

<details>
<summary><strong>macOS</strong></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "prompt2requirements": {
      "command": "node",
      "args": ["/path/to/prompt2requirements/dist/index.js"],
      "env": {
        "API_BASE_URL": "https://your-instance.com",
        "API_ACCESS_TOKEN": "ryc_v1_your_token_here"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Windows</strong></summary>

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "prompt2requirements": {
      "command": "node",
      "args": ["C:\\path\\to\\prompt2requirements\\dist\\index.js"],
      "env": {
        "API_BASE_URL": "https://your-instance.com",
        "API_ACCESS_TOKEN": "ryc_v1_your_token_here"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Linux</strong></summary>

Edit `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "prompt2requirements": {
      "command": "node",
      "args": ["/path/to/prompt2requirements/dist/index.js"],
      "env": {
        "API_BASE_URL": "https://your-instance.com",
        "API_ACCESS_TOKEN": "ryc_v1_your_token_here"
      }
    }
  }
}
```

</details>

Restart Claude Desktop. The hammer 🔨 icon at the bottom of the input area confirms that tools are loaded.

---

### Claude Code (CLI)

Add the server to your project or global config:

```bash
# Project-level (creates .claude/mcp.json)
claude mcp add prompt2requirements \
  -e API_BASE_URL=https://your-instance.com \
  -e API_ACCESS_TOKEN=ryc_v1_your_token_here \
  -- node /path/to/prompt2requirements/dist/index.js

# Or global
claude mcp add --global prompt2requirements \
  -e API_BASE_URL=https://your-instance.com \
  -e API_ACCESS_TOKEN=ryc_v1_your_token_here \
  -- node /path/to/prompt2requirements/dist/index.js
```

---

### Cursor

Open **Settings → MCP** (or edit `~/.cursor/mcp.json` on macOS/Linux, `%APPDATA%\Cursor\mcp.json` on Windows):

```json
{
  "mcpServers": {
    "prompt2requirements": {
      "command": "node",
      "args": ["/path/to/prompt2requirements/dist/index.js"],
      "env": {
        "API_BASE_URL": "https://your-instance.com",
        "API_ACCESS_TOKEN": "ryc_v1_your_token_here"
      }
    }
  }
}
```

---

### VS Code (GitHub Copilot / Cline / Roo)

Edit `.vscode/mcp.json` in your workspace, or your user `settings.json` under `"mcp.servers"`:

```json
{
  "servers": {
    "prompt2requirements": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/prompt2requirements/dist/index.js"],
      "env": {
        "API_BASE_URL": "https://your-instance.com",
        "API_ACCESS_TOKEN": "ryc_v1_your_token_here"
      }
    }
  }
}
```

---

### Any other MCP-compatible client

Use these values:

| Field | Value |
|---|---|
| Transport | `stdio` |
| Command | `node` |
| Args | `["/path/to/prompt2requirements/dist/index.js"]` |
| Env | `API_BASE_URL`, `API_ACCESS_TOKEN` |

---

## Usage

Once the server is connected, describe a feature in plain language:

> "I want to specify a new feature for my connected coffee machine project: a webhook to trigger coffee preparation from an external automation."

The LLM will guide you through the full flow using the available tools:

1. **Analyze** — breaks your prompt into a structured JSON requirements tree
2. **Refine** — iteratively applies your feedback to the tree
3. **Render** — converts the tree to a human-readable Markdown preview
4. **Submit** — publishes the final page to Confluence
5. **Breakdown to Jira** *(optional)* — creates one Jira issue per requirement and links them back to Requirement Yogi

---

## Available tools

| Tool | Role |
|---|---|
| `analyze_prompt` | Breaks a prompt into a structured JSON requirements tree |
| `refine_requirements` | Applies user feedback to refine the tree |
| `render_requirements` | Converts the JSON tree to Markdown for preview |
| `submit_requirements` | Publishes the final Markdown to Confluence via the Requirement Yogi API |
| `breakdown_to_jira` | Creates Jira issues from the tree and links them to Requirement Yogi |

---

## Output format

Requirements are rendered as structured Markdown tables.

**Parent requirement (vertical layout):**

```markdown
## Webhook for coffee preparation

| | |
| :--- | :--- |
| **Key** | WEBHOOK-001 |
| **Title** | Coffee brewing webhook |
| **Description** | Expose an HTTP endpoint to trigger brewing from external tools |
| **Priority** | Must |
```

**Child requirements (horizontal layout):**

```markdown
| Key | Title | Description | Acceptance criteria |
| :--- | :--- | :--- | :--- |
| RECV-001 | Receive and validate | Accept POST /brew | 200 if accepted, 400 if malformed |
| AUTH-001 | Authentication | Validate HMAC secret | 401 if secret invalid |
```

---

## Logs

MCP server logs are written by your client. For Claude Desktop:

| Platform | Log path |
|---|---|
| macOS | `~/Library/Logs/Claude/mcp-server-prompt2requirements.log` |
| Windows | `%APPDATA%\Claude\logs\mcp-server-prompt2requirements.log` |
| Linux | `~/.config/Claude/logs/mcp-server-prompt2requirements.log` |

```bash
# macOS / Linux
tail -f ~/Library/Logs/Claude/mcp-server-prompt2requirements.log
```

---

## Development

```bash
npm run dev    # run directly from source with tsx (no build needed)
npm run build  # compile TypeScript → dist/
npm run mock   # start a local mock API server on :3000
```

---

## Project structure

```
src/
├── index.ts                 # MCP server — registers all tools
├── schemas/
│   └── requirements.ts      # Zod schema + TypeScript types
└── tools/
    ├── analyze.ts            # analyze_prompt tool
    ├── refine.ts             # refine_requirements tool
    ├── render.ts             # render_requirements tool (JSON → Markdown)
    ├── submit.ts             # submit_requirements tool (POST to API)
    └── breakdownToJira.ts    # breakdown_to_jira tool
```

---

## License

MIT — see [LICENSE](LICENSE).
