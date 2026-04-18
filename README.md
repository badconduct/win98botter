# Win98Botter

Win98Botter is a multi-component control stack for Windows 98-era systems:

- `win98-mcp-agent` (C/Win32): on-machine primitive executor
- `relay-server` (Node.js): orchestration, API, UI, and persistence services
- `vb6-gui` (VB6): legacy native supervisor client

This README reflects the current implemented state, not a future-only design draft.

---

## Critical Build Requirement

The `win98-mcp-agent` binary is currently version **0.9** and should be compiled with **Visual Studio 6 (VC6) on Windows 98 SE** for real target deployment.

Do not treat modern toolchain builds (newer MSVC/MinGW) as production-equivalent for real Win98SE deployment. They may build, but can introduce runtime incompatibilities on target systems.

---

## Current Capabilities

1. Relay, UI, and agent connectivity paths are functional.
2. Agent-aware health and status reporting is implemented.
3. Setup and settings UX is implemented in the web UI and can test and save model endpoint config.
4. Agent lifecycle UX includes removal from dashboard tabs.
5. Log viewer supports level filtering for troubleshooting.
6. Win98 agent supports background service-style operation and local IPC and CLI usage.
7. Win98 agent writes persistent logs with INI-configurable verbosity.
8. Screenshot capture is supported end-to-end through the relay, with a dedicated permission toggle in the web UI.
9. Relay caches screenshot files and metadata in SQLite tool history and file cache records.
10. Relay includes PostgreSQL-backed Phase 1 map cache endpoints for:

- Directory scan captures
- File read captures
- Registry captures

---

## Repository Layout

```
win98botter/
├── docs/
│   └── PLANNING.md
├── relay-server/
│   └── PLAN.md
├── vb6-gui/
│   └── PLAN.md
└── win98-mcp-agent/
    └── PLAN.md
```

---

## Current Architecture

1. Win98/VB6 side sends requests and agent context.
2. Relay receives requests, builds orchestration context, and brokers tool execution.
3. Win98 agent executes primitive actions and returns structured results.
4. Relay stores conversational and operational history in SQLite.
5. Relay stores cached file metadata and screenshot captures in SQLite.
6. Relay stores Phase 1 environment map captures in PostgreSQL.

---

## Notable Recent Changes

1. Updated the assistant identity prompt so the relay persona is clearly distinct from the physical Win98 machine.
2. Added the `capture_screenshot` tool to the relay and Win98 agent.
3. Added a screenshot permission toggle to the web UI.
4. Added screenshot-awareness to the system prompt so the assistant can explain when visual capture is unavailable.
5. Fixed relay staging logic to correctly read Win98 file payloads and binary content.
6. Added SQLite caching for captured screenshots and their metadata.
7. Bumped the Win98 agent version to **0.9**.
8. Retained the previously completed settings, logging, service mode, and Phase 1 cache improvements.

---

## Sprint Recap (Current State)

1. File location caching is now persisted in relay SQLite and reused in later prompts.
2. Agent prompt guidance was expanded for Win98 path fallback behavior (for files like `WIN.INI`).
3. Relay now stores discovered directory structure and serves it via file-activity API routes.
4. Website File Activity panel now includes an expandable directory map (`+` / `-`) with directories first and files below.
5. Website map supports cached-file highlighting and inline file preview (when DB content exists).
6. LLM URL normalization was hardened to avoid malformed endpoint issues.
7. Chat failure handling was tightened to reduce silent/non-informative failures.
8. The experimental `vscode-extension/` workspace module was removed; the web dashboard is now the primary UI path.

---

## Quick Start (Current Dev Flow)

1. Start the relay stack from `relay-server`.
2. Configure the model endpoint and base URL in setup and settings.
3. Build `win98-mcp-agent` version **0.9** using **Visual Studio 6 on Windows 98 SE**, then start the agent in the desired mode.
4. If you want visual capture, enable `screenshot=1` in the agent permissions file and restart the agent.
5. Connect through the web dashboard or the VB6 client.

**Agent startup flags:**

| Flag                   | Effect                                               |
| ---------------------- | ---------------------------------------------------- |
| _(none)_               | Normal foreground mode                               |
| `-version`             | Print `Win98MCPAgent 0.9` and exit                   |
| `-service`             | Run as background Win9x service (hidden, auto-start) |
| `-install`             | Write autorun registry key and exit                  |
| `-uninstall`           | Remove autorun registry key and exit                 |
| `-cli <method> [args]` | Send one command via IPC pipe and exit               |

If using Docker Compose, ensure Postgres environment values match the relay configuration.

---

## Known Gaps

1. The Win98-side binary still needs to be rebuilt and redeployed whenever the C agent changes.
2. Full Win98SE regression coverage for the service, IPC, and screenshot paths is still in progress.
3. Map cache is at Phase 1 persistence level; deeper diff and merge intelligence is next.
4. Some historic directory rows may still need re-scan for perfect folder and type fidelity.
5. Release packaging and operator runbooks still need completion.

---

## Planning Docs

See component-level and project-level plans:

- `docs/PLANNING.md`
- `relay-server/PLAN.md`
- `win98-mcp-agent/PLAN.md`
- `vb6-gui/PLAN.md`
