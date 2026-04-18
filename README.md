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

## 🚀 Current Capabilities

Win98Botter is designed as a **modern control and assistance layer for real Windows 98 machines**. Instead of treating each old PC as an isolated box, this project gives you a central relay, a browser dashboard, an AI operator, and an auditable tool pipeline that can inspect, troubleshoot, and act on one or more connected systems.

### 🖧 Multi-agent relay and remote control

- The relay server accepts **multiple live Win98 agent connections at the same time**.
- Each connected machine is tracked as its own agent, with live status, heartbeat, hostname, and connection details.
- The dashboard lets you **switch between agents**, work on a specific target machine, and remove stale/offline entries when needed.
- If no machine is explicitly selected, the relay can fall back to the default live agent.

### 🤖 AI-assisted operations on the target machine

- The Node.js relay is the **main orchestration brain**: it handles chat requests, builds context, calls the LLM, and decides which Win98 tools to run.
- Through the agent, the system can perform real machine actions such as:
  - reading and writing files
  - browsing directories and cached file activity
  - reading and updating INI or registry values
  - launching commands and scripts
  - inspecting processes, windows, and system state
  - capturing screenshots for visual troubleshooting
- This makes the project useful for **legacy system administration, remote diagnostics, software repair, config editing, and historical environment inspection**.

### 🛡️ Permission-aware safety model

- Tool use is filtered by per-agent permissions before anything is executed on the Win98 side.
- Permissions can be adjusted from the web UI and pushed to the agent at runtime.
- That safety layer now includes **screenshot permission**, so visual capture can be explicitly enabled or disabled.

### 🌐 Web UI and operator workflow

- The web dashboard provides the main control surface for operators.
- It includes agent tabs, setup and settings pages, log viewing, chat history, system prompt inspection, permission toggles, and file activity views.
- The Settings flow now also exposes the optional PostgreSQL Phase 1 cache directly in the application, so users can enable or disable it themselves and edit the connection details without manually editing files.
- Health and status reporting are implemented so you can quickly see whether the relay and connected agents are alive and responding.

### 📸 Screenshot and visual troubleshooting

- Screenshot capture is supported **end-to-end** through the relay and the Win98 agent.
- The UI includes a dedicated screenshot permission toggle.
- When the AI needs visual confirmation, it can request a screenshot if allowed, and the relay can then read and cache the resulting BMP correctly.

### 🗃️ What the databases are for

The project uses **two persistence layers**, each with a different job:

- **SQLite** is the operational history store used by the relay. It keeps:
  - known agents
  - chat sessions
  - messages
  - tool call history
  - file change history
  - cached file locations
  - cached file contents
  - directory tree data
  - screenshot metadata and cached screenshot content

- **PostgreSQL** is the optional **Phase 1 map cache** used for structured environment capture and analysis, including:
  - directory scan captures
  - file read captures
  - registry captures

### ⚙️ Enabling or disabling the PostgreSQL cache

This feature is **optional** and can be toggled without changing the rest of the application design.

- **Enable it in the app**: open the Settings screen and use the **Enable PostgreSQL Phase 1 map cache** toggle in the ports and storage section.
- **Disable it in the app**: turn that same toggle off.
- **Configure it in the app**: the same Settings area lets users manage the PostgreSQL host, port, database name, username, password, and SSL mode.
- **Configure it manually**: edit the relay environment file and set:
  - `PHASE1_PG_ENABLED=1` to enable it
  - `PHASE1_PG_ENABLED=0` to disable it
- These values are stored in the relay application's own configuration, and existing DB settings remain in place unless the user explicitly changes them.
- When disabled, Win98Botter continues to work normally using **SQLite only** for operational history and cached file activity.

In practice, SQLite is the project’s day-to-day audit trail, while PostgreSQL is the deeper environment-mapping layer for building a reusable knowledge base of each machine.

### 🧰 Win98 agent runtime features

- The Win98 agent supports **background service-style operation**, local IPC, and CLI usage.
- It writes persistent logs with INI-configurable verbosity.
- It acts as the execution layer for the relay, returning structured results back to the modern control plane.

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
2. Configure the model endpoint, relay settings, and optional PostgreSQL cache in the Setup or Settings screens.
3. Build `win98-mcp-agent` version **0.9** using **Visual Studio 6 on Windows 98 SE**, then start the agent in the desired mode.
4. If you want visual capture, enable `screenshot=1` in the agent permissions file and restart the agent.
5. If you enable the PostgreSQL Phase 1 cache, confirm the DB connection values in Settings and restart the relay if needed.
6. Connect through the web dashboard or the VB6 client.

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
