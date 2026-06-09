# RY AI assistant — MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets any LLM client turn a plain-language prompt into a structured requirements tree, refine it through conversation, publish it as a Confluence page, all without leaving your chat interface.

**Your LLM does the thinking.** Our MCP server provides the knowledge and tools to guide your LLM through the process of using Requirement Yogi.

---

## Prerequisites

- A [Requirement Yogi](https://www.requirement-yogi.com) account with API credentials
- An MCP-compatible LLM client (see [Connecting your client](#connecting-your-client) below)
- (Optional) [Node.js](https://nodejs.org) 18 or later
- (Optional) npm (bundled with Node.js)

---

## Installation

### Option A — Download and install the latest release (recommended)

1. Download the latest release from the [releases page](https://github.com/requirement-yogi/ry-ai-assistant/releases).
2. Save the `.js` file to a location of your choice.
3. Add the [configuration to your client](#connecting-your-client).

### Option B — Clone and build

```bash
git clone https://github.com/requirement-yogi/ry-ai-assistant.git
cd ry-ai-assistant
npm install
npm run build
```

The compiled server is now at `dist/index.js`.

## Connecting your client

The server communicates over **stdio** — the standard MCP transport. Every MCP-compatible client uses a JSON configuration file. Replace `/path/to/ry-ai-assistant` with the actual absolute path where you cloned the repo.

### Claude Desktop

<details>
<summary><strong>macOS</strong></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ry-ai-assistant": {
      "command": "node",
      "args": ["/path/to/ry-ai-assistant/index.js"],
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
    "ry-ai-assistant": {
      "command": "node",
      "args": ["C:\\path\\to\\ry-ai-assistant\\index.js"],
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
    "ry-ai-assistant": {
      "command": "node",
      "args": ["/path/to/ry-ai-assistant/index.js"],
      "env": {
        "API_BASE_URL": "https://your-instance.com",
        "API_ACCESS_TOKEN": "ryc_v1_your_token_here"
      }
    }
  }
}
```

</details>

Restart Claude Desktop.

---

### Claude Code (CLI)

Add the server to your project or global config:

```bash
# Project-level (creates .claude/mcp.json)
claude mcp add ry-ai-assistant \
  -e API_BASE_URL=https://your-instance.com \
  -e API_ACCESS_TOKEN=ryc_v1_your_token_here \
  -- node /path/to/ry-ai-assistant/index.js

# Or global
claude mcp add --global ry-ai-assistant \
  -e API_BASE_URL=https://your-instance.com \
  -e API_ACCESS_TOKEN=ryc_v1_your_token_here \
  -- node /path/to/ry-ai-assistant/index.js
```

---

### Cursor

Open **Settings → MCP** (or edit `~/.cursor/mcp.json` on macOS/Linux, `%APPDATA%\Cursor\mcp.json` on Windows):

```json
{
  "mcpServers": {
    "ry-ai-assistant": {
      "command": "node",
      "args": ["/path/to/ry-ai-assistant/index.js"],
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
    "ry-ai-assistant": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/ry-ai-assistant/index.js"],
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
| Args | `["/path/to/ry-ai-assistant/index.js"]` |
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

---

## Available tools

| Tool | Role |
|---|---|
| `analyze_prompt` | Breaks a prompt into a structured JSON requirements tree |
| `refine_requirements` | Applies user feedback to refine the tree |
| `render_requirements` | Converts the JSON tree to Markdown for preview |
| `submit_requirements` | Publishes the final Markdown to Confluence via the Requirement Yogi API |

---

## License

The software is provided under the MIT license.

Copyright (c) 2026 Requirement Yogi,

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
