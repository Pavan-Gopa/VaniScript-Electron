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

* **API · Gemini** — the default; the assistant runs entirely through the Gemini API. This direct route has no MCP tool loop. It must never claim that it called a VaniScript MCP tool; use the Help Center entry point or answer from the local catalog instead.
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

## 8. Help and onboarding tools (all MCP clients)

The Electron MCP server exposes five read-only catalog tools for external Codex, Grok, Qwen, and other MCP clients. They use the existing MCP request/result envelope and accept an optional `language` request field. `language` controls only the language of help output; it is **not** the transcript source language, translation target language, or active project translation language.

| Tool | Input | Use |
| --- | --- | --- |
| `list_help_topics` | Optional `category`, `language` | Browse the catalog and discover stable topic IDs. |
| `get_help_topic` | Required `topicId`, optional `language` | Read one topic's requirements, numbered instructions, troubleshooting, and related topic IDs. Use a topic ID returned by `search_help` or `list_help_topics`; unknown IDs return a not-found error. |
| `search_help` | Required non-empty `query`, optional `language` and `limit` (1–10) | Find the best matching topics for a feature, screen, control, setting, or workflow. The result includes the canonical language, original query, bounded matches, and match count. |
| `get_contextual_help` | Optional `language` | Read the current screen/state, next actions, and recommended topic IDs from the active project context. |
| `get_onboarding_checklist` | Optional `language` | Read the complete first-project checklist with ordered steps and topic IDs. |

### Search-first response contract

For a how-to question about a VaniScript screen, feature, control, setting, or workflow:

1. Call `search_help` **before answering**, passing `language: "en"` or `language: "ru"` to match the language of the latest user message (`ru` for Russian; `en` otherwise).
2. If the answer depends on the user's current screen or project state, also call `get_contextual_help` with that same canonical language.
3. If a beginner asks where to start or how to make a first project, call `get_onboarding_checklist` with that same canonical language.
4. When a matching topic is selected, call `get_help_topic` with its returned `topicId` for the complete instructions. Do not invent a topic or silently substitute the first catalog entry when search has no match.
5. Explain clicks and workflows in the user's language, but preserve the exact English button and screen labels returned by the tools (for example, `Initialize Engine`, `Approve & Next`, `Settings > Models`) so the user can find them in the UI.

Do not confuse help/UI locale with `defaultSourceLang`, `defaultTargetLang`, a translation-language selector, or transcript content. An explicit MCP `language` takes precedence over persisted Help Center locale; invalid or missing values normalize to canonical `en`.

The embedded `MCP · Grok` and `MCP · Qwen` routes may follow this tool contract because they run through the local MCP server. The direct `API · Gemini` route has no MCP loop and must not display, imply, or claim that a help tool (or any other MCP tool) ran. It should direct the user to Help Center/local catalog guidance instead. There is no heuristic help-intent classifier and no silent MCP-to-API fallback.

---

### Security notes

- Auth is a **Bearer token** in the `Authorization` header (the server also accepts an
  `x-vaniscript-mcp-token` header). This is the same token the embedded chat uses.
- The server binds to loopback only and rejects non-loopback `Origin` headers, so localhost
  clients work without any CORS change.
- Token handling follows the QWEN_MCP invariants: no silent MCP→API fallback, isolated
  project-scope MCP config, and the token lives only in the client environment / config.

