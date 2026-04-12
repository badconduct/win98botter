# Win98Botter

Win98Botter is a multi-component control stack for Windows 98-era systems:

- `win98-mcp-server` (C/Win32): on-machine primitive executor
- `relay-server` (Node.js): orchestration/API/UI/data services
- `vb6-gui` (VB6): legacy native supervisor client

This README reflects the current implemented state, not a future-only design draft.

---

## Current Capabilities

1. Relay, UI, and agent connectivity paths are functional.
2. Agent-aware health/status reporting is implemented.
3. Setup/settings UX is implemented in web UI and can test/save model endpoint config.
4. Agent lifecycle UX includes removal from dashboard tabs.
5. Log viewer supports level filtering for troubleshooting.
6. Win98 agent supports background service-style operation and local IPC/CLI usage.
7. Win98 agent writes persistent logs with INI-configurable verbosity.
8. Relay includes PostgreSQL-backed Phase 1 map cache endpoints for:
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
└── win98-mcp-server/
    └── PLAN.md
```

---

## Current Architecture

1. Win98/VB6 side sends requests and agent context.
2. Relay receives requests, builds orchestration context, and brokers tool execution.
3. Win98 agent executes primitive actions and returns structured results.
4. Relay stores conversational/operational history in SQLite.
5. Relay stores Phase 1 environment map captures in PostgreSQL.

---

## Notable Recent Changes

1. Fixed route/config workflows that previously caused invalid LLM target URL behavior.
2. Added concrete `/settings` behavior and improved `/setup` flow.
3. Added agent remove UX and API support.
4. Added log-level filtering controls.
5. Added Win98 service mode + install/uninstall flags.
6. Added named-pipe IPC + local CLI mode in Win98 agent.
7. Added persistent logging controls in `AGENT.INI`.
8. Added PostgreSQL map-cache schema/endpoints and compose wiring.

---

## Quick Start (Current Dev Flow)

1. Start relay stack (including PostgreSQL) from `relay-server`.
2. Configure model endpoint/base URL in setup/settings.
3. Start Win98 agent in desired mode (`normal`, `-service`, or CLI/IPC path).
4. Connect through web dashboard or VB6 client.

If using Docker Compose, ensure Postgres environment values match the relay configuration.

---

## Known Gaps

1. Full Win98SE regression coverage for newly added service/IPC paths is still in progress.
2. Map cache is at Phase 1 persistence level; deeper diff/merge intelligence is next.
3. Release packaging and operator runbooks still need completion.

---

## Planning Docs

See component-level and project-level plans:

- `docs/PLANNING.md`
- `relay-server/PLAN.md`
- `win98-mcp-server/PLAN.md`
- `vb6-gui/PLAN.md`
