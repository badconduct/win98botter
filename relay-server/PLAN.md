# Relay Server Plan (Current)

## Role

`relay-server` is the orchestration and control plane between clients/UI and Win98 agents. It owns API surfaces, health/state aggregation, session history, and now the first phase of persistent map caching.

---

## Current Implementation Status

### Implemented

1. REST API and SSE logging stream are running.
2. Agent registration/state health integration is in place.
3. System prompt flow includes agent context payload (`agentInfo`) and permission-aware behavior.
4. UI route behavior supports setup/settings flows.
5. Agent removal endpoint and dashboard UX are implemented.
6. Client request behavior for bodyless DELETE calls is fixed.
7. Log viewer includes level filters for cleaner troubleshooting.
8. Static route fallback/noise handling has been improved.

### Data Layer

1. SQLite operational history remains active (sessions, messages, tool calls, file changes).
2. PostgreSQL Phase 1 cache store is implemented and wired into startup/shutdown lifecycle.

---

## Phase 1 Cache Endpoints (Implemented)

1. `POST /api/map/files/dir-scan`
2. `GET /api/map/files`
3. `POST /api/map/files/read-capture`
4. `GET /api/map/files/read-capture`
5. `POST /api/map/registry/capture`
6. `GET /api/map/registry`

These endpoints currently provide persisted capture/retrieval primitives and path normalization to support Windows-centric usage.

---

## Recent Fixes Captured in This Plan

1. Health route now aligns with live registry/session state and includes agent identifiers.
2. Missing/invalid LLM URL behavior is operationally addressable through setup/settings UX.
3. `/setup` and `/settings` flow behavior is functional in the UI.
4. Agent tab removal actions are fully wired front-to-back.
5. Log stream triage improved through filter chips and reduced noise.
6. Compose stack now includes PostgreSQL service for map cache.

---

## Open Work

1. Cache Phase 2:
   - Diff and freshness semantics
   - Selective rehydration for context assembly
   - Integration into orchestration loop decisions
2. Stronger failure-mode handling:
   - Reconnect/replay behavior around interrupted cache writes
   - Better reconciliation between SQLite history and PG snapshots
3. Test expansion:
   - API contract tests for cache endpoints
   - UI integration tests for settings/remove/log filters

---

## Near-Term Execution Order

1. Add Phase 2 cache schema + queries.
2. Plug cache-aware retrieval into planning/context steps.
3. Add regression tests around agent lifecycle and settings flow.
4. Harden deployment docs and runtime diagnostics.
