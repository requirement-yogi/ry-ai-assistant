# RY AI assistant — MCP Server

**Manage your [Requirement Yogi](https://www.requirementyogi.com) requirements by simply asking for it.**

This is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server. Add it to Claude Desktop, Claude Code, Cursor or any other MCP client, and you can ask that client to:

- **Create or Update a requirements page** from a plain-language description or an existing page.
- **Link requirements to Jira issues.**
- **Build a traceability matrix** and save it as a reusable query.

Your LLM does the thinking; this server knows the Requirement Yogi rules it can't — where a macro may live in a page, which columns a matrix can really carry — and applies them for you. Publishing the pages and creating the Jira issues stay with your Atlassian MCP.

---

## Installation

Follow these six steps in order.

### 1. Have a Confluence instance with Requirement Yogi

You need a Confluence instance with the [Requirement Yogi](https://www.requirementyogi.com) app installed. Note whether your data is hosted in the **EU** or the **US** — you'll need it in step 5.

### 2. Create a Requirement Yogi personal access token

In the Requirement Yogi standalone app, generate a **personal access token**. 

### 3. Use an LLM client that supports local MCP servers

Any MCP-compatible client works — [Claude Desktop](https://claude.ai/download), [Claude Code](https://docs.claude.com/en/docs/claude-code), [Cursor](https://cursor.com), VS Code (Copilot / Cline / Roo), and others.

### 4. (Optional) Add the Atlassian MCP to your LLM client

Install the **Atlassian MCP** in your client. This server relies on it to publish the pages it produces and to find or create the Jira issues you want to link. See Atlassian's documentation for the setup.
> **Note:** This step is not mandatory, but we strongly recommend it so you have the full power of the atlassian + requirement yogi ecosystem.

### 5. Configure the MCP server

The **one-click bundle** below is by far the simplest way. use it if you're on Claude Desktop. Any other client uses the manual setup.

<details>
<summary><strong>Claude Desktop — one-click (recommended)</strong></summary>

1. Download **`ry-ai-assistant.mcpb`** from the [releases page](https://github.com/requirement-yogi/ry-ai-assistant/releases/latest/download/ry-ai-assistant-installer.mcpb).
2. Double-click the file — Claude Desktop opens its installer. (Or, in Claude Desktop: **Settings → Extensions → Install extension…** and pick the file.)
3. Fill the installation wizard form: 
   - set **Data residency** to `EU` or `US`, 
   - paste your **personal access token**,

</details>

<details>
<summary><strong>Other clients — manual setup</strong> (Claude Code, Cursor, VS Code, or Claude Desktop by hand)</summary>

**a. Get the server file.** Download `ry-ai-assistant.mjs` from the [releases page](https://github.com/requirement-yogi/ry-ai-assistant/releases/latest/download/ry-ai-assistant.mjs) and save it somewhere permanent. Note its full path.

**b. Add the configuration to your client.** Pick your client below. In every case, replace `/path/to/ry-ai-assistant.mjs` with the real path from step 5a, set `RY_DATA_RESIDENCY` to `EU` or `US` (step 1), and paste your token from step 2.

<details>
<summary><strong>Claude Desktop (by hand)</strong></summary>

Open the config file for your OS and add the `ry-ai-assistant` block:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

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

On Windows, write the path with double backslashes, e.g. `"C:\\path\\to\\ry-ai-assistant.mjs"`.

</details>

<details>
<summary><strong>Claude Code (CLI)</strong></summary>

```bash
claude mcp add ry-ai-assistant \
  --env RY_DATA_RESIDENCY=EU \
  --env RY_PERSONAL_ACCESS_TOKEN=<your-personal-access-token> \
  -- node /path/to/ry-ai-assistant.mjs
```

Add `--global` right after `add` to install it for all your projects.

</details>

<details>
<summary><strong>Cursor</strong></summary>

Open **Settings → MCP**, or edit `~/.cursor/mcp.json` (macOS/Linux) / `%APPDATA%\Cursor\mcp.json` (Windows):

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
<summary><strong>VS Code (Copilot / Cline / Roo)</strong></summary>

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

</details>

<details>
<summary><strong>Any other MCP-compatible client</strong></summary>

| Field | Value |
|---|---|
| Transport | `stdio` |
| Command | `node` |
| Args | `["/path/to/ry-ai-assistant.mjs"]` |
| Env | `RY_DATA_RESIDENCY` = `EU` or `US`, `RY_PERSONAL_ACCESS_TOKEN` = your token |

</details>

**What the two settings mean:**

| Setting | Value |
|---|---|
| `RY_DATA_RESIDENCY` | `EU` or `US` — where your Requirement Yogi instance is hosted (step 1). |
| `RY_PERSONAL_ACCESS_TOKEN` | Your Requirement Yogi personal access token (step 2). |

</details>

### 6. Restart your LLM client

Fully quit and reopen your client so it picks up the new server. The `ry-ai-assistant` tools are now available in your chat.

---

## License

This repository is published under APL 2.0, see the [LICENSE](LICENSE) file.
