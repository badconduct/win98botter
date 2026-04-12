# Win98Botter Planning (Current State)

## Project Summary

Win98Botter is now a working multi-component system:

- A Windows 98/Win32 MCP agent written in C (`win98-mcp-server`)
- A Node.js relay server with REST/SSE APIs and web UI (`relay-server`)
- A VB6 supervisor GUI (`vb6-gui`)

The architecture remains the same: Win98 executes primitives, the relay manages orchestration/state/context, and the UI surfaces control and observability.

---

## Current Snapshot

### What Is Implemented

1. Core relay + agent connectivity is operational.
2. Tool schema visibility and permission mapping are wired through the relay and agent behavior.
3. Health reporting now reflects live agent registration and `agent_id` context.
4. Settings UX exists in the web UI (`/setup` and `/settings`) and can test/save LLM configuration.
5. Agent management includes remove/delete from the dashboard.
6. Log UX includes level filtering and reduced static noise.
7. Win98 agent supports service-style background mode, install/uninstall flags, and local IPC/CLI mode.
8. Win98 agent persistent logging is implemented, configurable via INI.
9. Phase 1 PostgreSQL map cache is implemented in the relay with API endpoints and compose integration.

### What Is Not Finished

1. End-to-end validation on real Win98SE hardware/VM for all new service + IPC flows.
2. Full Phase 2+ cache intelligence (diff/undo-aware map orchestration beyond Phase 1 storage endpoints).
3. Documentation expansion files previously listed as planned (`ARCHITECTURE.md`, `PERMISSIONS.md`, etc.).
4. Packaging/distribution hardening and install workflow.

---

## How We Got Here (Recent Milestones)

1. Stabilized relay route wiring and health behavior.
2. Fixed configuration/runtime pain points:
   - Missing LLM base URL caused invalid `/chat/completions` target.
   - Added real settings route behavior so this can be corrected in-app.
3. Improved web UI operations:
   - Agent tab remove button
   - Log level filtering
   - Reduced noisy static/fallback errors
4. Expanded Win98 runtime model:
   - Service flags (`-service`, `-install`, `-uninstall`)
   - Hidden/background operation
   - Named pipe IPC + CLI mode
5. Added persistent file logging in Win98 agent with INI controls.
6. Implemented and deployed PostgreSQL-backed Phase 1 map cache:
   - Directory snapshots
   - File read captures
   - Registry captures
   - Docker Compose integration and smoke tests

---

## Active Architecture

## Components

- `win98-mcp-server`: Win98-safe primitive executor, service/CLI/IPC capable, persistent local logging.
- `relay-server`: Orchestrator, API surface, browser UI, SQLite operational history + PostgreSQL Phase 1 cache.
- `vb6-gui`: Win98 native supervisor and relay client, now passing agent context fields used by relay flows.

## Data Stores

1. SQLite (relay): sessions/messages/tool calls/file changes.
2. PostgreSQL (relay Phase 1 cache):
   - Directory map snapshots
   - File read captures
   - Registry map snapshots

---

## Roadmap (Updated)

## Phase A: Win98SE Validation Pass

1. Validate service install/start/stop/uninstall behavior on Win98SE.
2. Validate named-pipe IPC reliability under repeated command load.
3. Validate logging path/rotation strategy on constrained disks.

## Phase B: Map Cache Phase 2

1. Add cache diff APIs and freshness metadata.
2. Introduce merge/patch semantics for map updates.
3. Connect cache-aware context assembly into chat planning loop.

## Phase C: Safety + Recovery

1. Expand undo/replay guarantees across file + registry actions.
2. Add crash-safe reconciliation for interrupted write sequences.
3. Add automated consistency checks between SQLite history and cache state.

## Phase D: Packaging and Operator Docs

1. Build repeatable release artifacts for agent/relay/UI.
2. Add deployment and ops runbooks.
3. Add troubleshooting matrix for Win11 host vs Win98SE target setups.

---

## Immediate Next Actions

1. Run full Win98SE smoke/regression tests for new agent runtime modes.
2. Add Phase 2 cache primitives (diff + staleness + selective fetch) in relay.
3. Close remaining README and per-component docs gaps as behavior stabilizes.
