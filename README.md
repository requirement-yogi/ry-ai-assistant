# RY AI assistant — MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets any LLM client place [Requirement Yogi](https://www.requirementyogi.com) macros into Confluence pages — either by building a brand-new page from a plain-language prompt, or by analyzing an existing page and reshaping it so its requirements become indexable. It can also search your requirements and link them to Jira issues through the Requirement Yogi API. All without leaving your chat interface.

**Your LLM does the thinking.** Our MCP server owns the Requirement Yogi indexing rules and produces the Confluence page body (ADF) deterministically. Publishing the page itself is delegated to your Confluence/Atlassian MCP tools, and so is finding or creating the Jira issues to link.

---

## Prerequisites

- [Node.js](https://nodejs.org) 18 or later (to run the server)
- An MCP-compatible LLM client (see [Connecting your client](#connecting-your-client) below)
- Confluence/Atlassian MCP tools connected in the same client, used to publish the page the server produces and to find/create the Jira issues to link
- A Confluence instance with the [Requirement Yogi](https://www.requirementyogi.com) app installed
- For the Jira-linking tools: a Requirement Yogi **personal access token** (see [Configuration](#configuration) below)

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
npm run build:prod
```

The standalone server bundle is now at `standalone/ry-ai-assistant.mjs` — point your client configuration at that file (see [Connecting your client](#connecting-your-client)).

## Configuration

The server is configured through **environment variables**, set in the `env` section of your client's MCP configuration (see the examples in [Connecting your client](#connecting-your-client)):

| Environment variable | Value |
|---|---|
| `RY_DATA_RESIDENCY` | `EU` or `US` — the data residency of your Requirement Yogi instance. The server maps it to the right Requirement Yogi API hosts. |
| `RY_PERSONAL_ACCESS_TOKEN` | Your Requirement Yogi personal access token, used to authenticate against the Requirement Yogi APIs. |

Both variables are required by the requirement search and Jira-linking tools. The page-authoring tools (`build_requirements_adf`, `edit_page_requirements`) work without them.

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
      "args": ["/path/to/ry-ai-assistant.mjs"],
      "env": {
        "RY_DATA_RESIDENCY": "EU",
        "RY_PERSONAL_ACCESS_TOKEN": "<your-personal-access-token>"
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
      "args": ["C:\\path\\to\\ry-ai-assistant.mjs"],
      "env": {
        "RY_DATA_RESIDENCY": "EU",
        "RY_PERSONAL_ACCESS_TOKEN": "<your-personal-access-token>"
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
      "args": ["/path/to/ry-ai-assistant.mjs"],
      "env": {
        "RY_DATA_RESIDENCY": "EU",
        "RY_PERSONAL_ACCESS_TOKEN": "<your-personal-access-token>"
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
  --env RY_DATA_RESIDENCY=EU \
  --env RY_PERSONAL_ACCESS_TOKEN=<your-personal-access-token> \
  -- node /path/to/ry-ai-assistant.mjs

# Or global
claude mcp add --global ry-ai-assistant \
  --env RY_DATA_RESIDENCY=EU \
  --env RY_PERSONAL_ACCESS_TOKEN=<your-personal-access-token> \
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
      "args": ["/path/to/ry-ai-assistant.mjs"],
      "env": {
        "RY_DATA_RESIDENCY": "EU",
        "RY_PERSONAL_ACCESS_TOKEN": "<your-personal-access-token>"
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
      "args": ["/path/to/ry-ai-assistant.mjs"],
      "env": {
        "RY_DATA_RESIDENCY": "EU",
        "RY_PERSONAL_ACCESS_TOKEN": "<your-personal-access-token>"
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
| Args | `["/path/to/ry-ai-assistant.mjs"]` |
| Env | `RY_DATA_RESIDENCY` = `EU` or `US`, `RY_PERSONAL_ACCESS_TOKEN` = your token |

## License

This repository is published under APL 2.0, see the [LICENSE](LICENSE) file.
