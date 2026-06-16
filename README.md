# RY AI assistant — MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets any LLM client turn a plain-language prompt into a structured requirements tree, refine it through conversation, publish it as a Confluence page, all without leaving your chat interface.

**Your LLM does the thinking.** Our MCP server provides the knowledge and tools to guide your LLM through the process of using Requirement Yogi.

---

## Prerequisites

- An MCP-compatible LLM client (see [Connecting your client](#connecting-your-client) below)
- (Optional) [Node.js](https://nodejs.org) 18 or later
- (Optional) npm (bundled with Node.js)

---

## Installation

### Option A — Download and install the latest release (recommended)

1. Download the latest release from the [releases page](https://github.com/requirement-yogi/ry-ai-assistant/releases).
2. Save the `ry-ai-assistant.mjs` file to a location of your choice.
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
      "args": ["/path/to/ry-ai-assistant.mjs"]
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
      "args": ["C:\\path\\to\\ry-ai-assistant.mjs"]
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
      "args": ["/path/to/ry-ai-assistant.mjs"]
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
  -- node /path/to/ry-ai-assistant.mjs

# Or global
claude mcp add --global ry-ai-assistant \
  -- node /path/to/ry-ai-assistant.mjs
```

---

### Cursor

Open **Settings → MCP** (or edit `~/.cursor/mcp.json` on macOS/Linux, `%APPDATA%\Cursor\mcp.json` on Windows):

```json
{
  "mcpServers": {
    "ry-ai-assistant": {
      "command": "node",
      "args": ["/path/to/ry-ai-assistant.mjs"]
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
      "args": ["/path/to/ry-ai-assistant.mjs"]
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
| Args | `["/path/to/ry-ai-assistant.mjs"]` |

## License

This repository is published under APL 2.0, see the [LICENSE](LICENSE) file.
