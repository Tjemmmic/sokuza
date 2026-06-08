# Interactive CLI and MCP Integration Plan

This plan outlines the technical changes required to bring interactive developer CLIs (Claude Code, Gemini CLI, opencode, Codex) directly into Sokuza in a parallel, tandem fashion that does not disrupt existing headless workflows.

---

## User Review Required

> [!IMPORTANT]
> **Native C++ Dependency (`node-pty`)**:
> Spawning real Pseudo-Terminals requires native bindings. Sokuza will need to add `node-pty` as a dependency. When running `npm install`, this requires a local compiler toolchain (Python, make, g++). If Sokuza runs in docker/production environments, the Dockerfile will need build tools installed.

> [!WARNING]
> **Security & PTY Terminal Takeover**:
> Exposing terminal input to the browser allows arbitrary shell execution on the host machine running the Sokuza daemon. The WebSocket connection for `/api/pty/:id` must be tightly gated behind the same bearer token authentication used by the rest of the Sokuza dashboard.

---

## Open Questions

> [!NOTE]
> **MCP Stdio vs HTTP**:
> Should Sokuza's MCP server run over Stdio (executed via `sokuza mcp` in your local terminal) or via HTTP/SSE endpoints on port 24847? Stdio is the most compatible with Claude Code's current config model, so we propose starting with Stdio, with HTTP as a future option.

---

## Proposed Changes

### Component 1: PTY Process & Terminal streaming (Fastify + node-pty)

Expose an interactive PTY backend to run CLIs and stream their output via WebSockets.

#### [NEW] [pty-manager.ts](file:///home/tjemmmic/dev/sokuza/src/core/pty-manager.ts)

- Implement `PTYManager` class to spawn and keep track of active PTY sessions.
- Expose methods `createSession(command, args, cwd)`, `write(id, data)`, `resize(id, cols, rows)`, and `kill(id)`.
- Emit events when the PTY receives output, gets resized, or terminates.

#### [MODIFY] [server.ts](file:///home/tjemmmic/dev/sokuza/src/server/server.ts)

- Register `@fastify/websocket` to support websocket routes.
- Add WebSocket route `/api/pty/:id` that authenticates via the dashboard bearer token, initiates a connection, and pipes characters bidirectionally between `PTYManager` and the browser.

#### [MODIFY] [api.ts](file:///home/tjemmmic/dev/sokuza/src/server/api.ts)

- Add POST endpoint `/api/pty/spawn` to start a new PTY session for a specific repo/PR.
- Expose GET `/api/pty/sessions` to list active interactive sessions.

---

### Component 2: Sokuza MCP Server

Expose Sokuza's internal databases (reviews, PR metadata) to external CLI clients.

#### [NEW] [mcp-server.ts](file:///home/tjemmmic/dev/sokuza/src/core/mcp-server.ts)

- Implement a standard Model Context Protocol (MCP) server.
- Register tools:
  - `sokuza_get_pr_context`: returns branch, repository, and latest commit info.
  - `sokuza_get_review_findings`: reads files from `~/.sokuza/runs/ai-review/` to return P1/P2/P3 issues.
  - `sokuza_report_status`: writes status log updates to Sokuza's engine dashboard.
  - `sokuza_ask_human`: routes a prompt to the dashboard chat window and blocks the CLI until answered.

#### [MODIFY] [index.ts](file:///home/tjemmmic/dev/sokuza/src/index.ts)

- Register a new CLI subcommand command: `sokuza mcp`.
- When run, this command instantiates Sokuza's `MCPServer` communicating over standard input and output (stdio), making it pluggable into `~/.claude.json`.

---

### Component 3: CLI Session Log Watcher

Expose transcripts of local CLI commands in Sokuza's web UI.

#### [NEW] [session-watcher.ts](file:///home/tjemmmic/dev/sokuza/src/core/session-watcher.ts)

- Spawn a directory watcher (using `chokidar` or Node's `fs.watch`) pointing at `.claude/sessions/` inside persistent PR workdirs.
- On file modification, parse the JSON session transcripts (questions, tool calls, shell inputs).
- Format and broadcast the transcript events to the dashboard's event stream.

#### [MODIFY] [engine.ts](file:///home/tjemmmic/dev/sokuza/src/core/engine.ts)

- Initialize `SessionWatcher` on engine startup.
- Stop watching workdirs when they are evicted/cleaned up.

---

### Component 4: Dashboard UI Updates (Vanilla HTML/JS)

Render the interactive console and mirror CLI logs in Sokuza's dashboard.

#### [MODIFY] [index.html](file:///home/tjemmmic/dev/sokuza/dashboard/index.html)

- Load `xterm.js` and `xterm-addon-fit` via CDN/local assets.
- Add a new "Terminal Console" tab to the PR view and the Chat tab.
- Add a "CLI Transcripts" feed to the Auto-Fix panel.

#### [MODIFY] [app.js](file:///home/tjemmmic/dev/sokuza/dashboard/app.js)

- Instantiate `Terminal` when terminal tabs are selected.
- Open WebSocket connection to `/api/pty/:id` passing the token in protocol headers/auth message.
- Stream input from keypresses via the WebSocket, and draw PTY outputs to the xterm terminal.
- Render the watched local CLI session transcripts dynamically in the timeline.

#### [MODIFY] [styles.css](file:///home/tjemmmic/dev/sokuza/dashboard/styles.css)

- Add sizing and glassmorphic color themes for terminal emulator frames.

---

## Verification Plan

### Automated Tests

- **PTY Tests**: Unit test PTY session lifecycle (`src/__tests__/pty-manager.test.ts`), verifying commands spawn, stream data, resize, and close safely.
- **MCP Server Tests**: Unit test the MCP tools (`src/__tests__/mcp-server.test.ts`), verifying tools return correct JSON shapes for mock PR contexts.
- **Session Watcher Tests**: Mock filesystem updates in `.claude/sessions/` and verify they parse correctly without throwing (`src/__tests__/session-watcher.test.ts`).

### Manual Verification

1. Run `sokuza mcp` and test compatibility using the official `@modelcontextprotocol/inspector` tool.
2. Open Sokuza's dashboard and start an interactive `claude` session inside the PTY Console. Type commands and assert responsiveness.
3. Configure Claude Code to load Sokuza's MCP server and assert it can query PR issues.
4. Run Claude Code locally inside Sokuza's workspace and check if the dashboard reflects the session transcript dynamically.
