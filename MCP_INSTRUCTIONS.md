# VaniScript Local MCP Server Integration

When the VaniScript application is running, it exposes a local Model Context Protocol (MCP) server utilizing the HTTP/SSE transport standard.

This allows external AI agents, coding assistants, and IDEs to connect directly to VaniScript to view project state, update timed subtitle transcriptions, align translations, and manage shorts rendering.

## Server Endpoints

Depending on the workspace version you are running:
* **Electron version**: `http://127.0.0.1:19789/sse`
* **Apple Silicon (Native Swift) version**: `http://127.0.0.1:19790/sse`

---

## 1. Claude Code
Claude Code supports direct HTTP/SSE connections. In your terminal, run:

### Electron Version:
```bash
claude mcp add --transport sse vaniscript http://127.0.0.1:19789/sse
```

### Swift/Apple Silicon Version:
```bash
claude mcp add --transport sse vaniscript http://127.0.0.1:19790/sse
```

---

## 2. Codex
Codex can connect directly to the running SSE server:

### Electron Version:
```bash
codex mcp add vaniscript --url http://127.0.0.1:19789/sse
```

### Swift/Apple Silicon Version:
```bash
codex mcp add vaniscript --url http://127.0.0.1:19790/sse
```

---

## 3. Cursor IDE
Cursor supports native HTTP/SSE servers:
1. Go to **Cursor Settings** -> **Features** -> **MCP**.
2. Click **+ Add New MCP Server**.
3. Configure as follows:
   * **Name**: `VaniScript`
   * **Type**: `SSE`
   * **URL**: `http://127.0.0.1:19789/sse` *(Use `19790` for Swift version)*
4. Click **Save**.

---

## 4. Claude Desktop
Since Claude Desktop currently only supports `stdio` subprocess commands, you can use the lightweight Python bridge included in this directory to route communications:

Edit your Claude Desktop configuration file (`~/Library/Application Support/Claude/claude_desktop_config.json`) and append:

### For Electron:
```json
{
  "mcpServers": {
    "vaniscript": {
      "command": "python3",
      "args": [
        "/Users/pavan/Documents/AI Projects/VaniScript/Electron/mcp_bridge.py"
      ]
    }
  }
```

---

## 6. Grok

Grok can connect to VaniScript in two ways.

### A. External Grok (desktop app / CLI)
Point the Grok CLI at the running SSE server (Electron port **19789**):

```bash
grok mcp add vaniscript --transport sse --url http://127.0.0.1:19789/sse
```

This exposes every VaniScript tool (read project state, edit transcript/translation, manage subtitle styles and shorts plans, trigger renders) to Grok as a normal MCP server.

### B. Embedded Grok chat (in-app assistant)
The VaniScript chat panel has a **route selector** in its header:

* **API · Gemini** — the default; the assistant runs entirely through the Gemini API. This route is used *only* when explicitly selected and never as a silent fallback.
* **MCP · Grok** — VaniScript launches the locally installed `grok` CLI headless in the main process, pointed at the in-app MCP SSE server (`http://127.0.0.1:19789/sse`). Grok performs the agentic loop itself: it calls VaniScript tools through the existing MCP bridge (`onMcpCallTool` / `executeMcpTool`), and the streamed reply is rendered back into the chat panel.

Requirements for the embedded route:

* The `grok` CLI must be installed (checked at `~/.grok/bin/grok`, `/usr/local/bin/grok`, `/opt/homebrew/bin/grok`, or anywhere on `PATH`).
* You must be logged in (`grok login`).
* The VaniScript app must be running (the MCP SSE server listens on `127.0.0.1:19789`).

If `grok` is missing or not logged in, the chat shows a clear error and does **not** fall back to any other provider.

### For Swift/Apple Silicon:
```json
{
  "mcpServers": {
    "vaniscript": {
      "command": "python3",
      "args": [
        "/Users/pavan/Documents/AI Projects/VaniScript/AppleSilicon/mcp_bridge.py"
      ]
    }
  }
}
```

---

## 5. Google Antigravity & AI Developer Platforms
To register the server globally inside the Antigravity developer environment:
1. Edit the global config: `~/.gemini/config/mcp_config.json`
2. Add the server entry pointing to the bridge script:
   ```json
   "vaniscript": {
     "command": "python3",
     "args": [
       "/Users/pavan/Documents/AI Projects/VaniScript/Electron/mcp_bridge.py"
     ]
   }
   ```

---

## 7. Qwen (external CLI)

This documents how a **manually launched Qwen CLI** (not the in-app embedded Qwen chat)
can connect to the VaniScript Electron MCP server and use its tools. The embedded chat is
already wired through `.qwen/settings.json` with env-var token substitution; this is the
equivalent setup for a terminal Qwen session you start yourself.

### Prerequisites

- The **VaniScript (Electron) application must be running** so the MCP SSE server is active
  on `http://127.0.0.1:19789/sse`.
- Install and authenticate the Qwen CLI:

  ```bash
  npm install -g @qwen-code/qwen-code
  qwen login
  ```

- The access token comes from VaniScript **Settings → MCP → Access Token** (or is generated
  automatically the first time the Local MCP Server is enabled). It is the same bearer token
  used by the embedded chat.

### Option A — `qwen mcp add` (project scope)

```bash
# Add the VaniScript MCP server to Qwen CLI (project scope):
qwen mcp add vaniscript http://127.0.0.1:19789/sse \
  --transport sse \
  --header "Authorization: Bearer <YOUR_TOKEN>" \
  --scope project \
  --trust
```

### Option B — `.qwen/settings.json`

```json
{
  "mcpServers": {
    "vaniscript": {
      "url": "http://127.0.0.1:19789/sse",
      "transport": "sse",
      "headers": {
        "Authorization": "Bearer <YOUR_TOKEN>"
      },
      "trust": true
    }
  }
}
```

### Available tools

Once connected, Qwen can call the VaniScript MCP tools. The exact set is filtered by the
permission scopes enabled in VaniScript Settings. Start from `get_capabilities`, which
returns the active scopes and available tool groups without exposing secrets. The Electron
build exposes, among others:

- `get_project_state` — current project, source media, languages, and providers.
- `get_subtitle_style` — read the active subtitle/caption style.
- `get_shorts_plans` — list planned shorts/clip plans.
- `update_chunk_text`, `approve_chunk` — correct and approve transcript chunks.
- `update_subtitle_style`, `create_shorts_plan`, `set_background_settings`, `trigger_render`.

Every mutation can accept `expectedRevision` and `requestId`; long-running work returns a
`jobId` you can follow with `get_job`, `list_jobs`, or `cancel_job`.

### Security notes

- Auth is a **Bearer token** in the `Authorization` header (the server also accepts an
  `x-vaniscript-mcp-token` header). This is the same token the embedded chat uses.
- The server binds to loopback only and rejects non-loopback `Origin` headers, so localhost
  clients work without any CORS change.
- Token handling follows the QWEN_MCP invariants: no silent MCP→API fallback, isolated
  project-scope MCP config, and the token lives only in the client environment / config.

