# VB6 GUI Plan (Current)

## Role

`vb6-gui` is the legacy operator-facing control surface for Win98-side usage. It provides chat/control UX and user-managed permissions, and forwards request context to relay APIs.

---

## Current Implementation Status

### Implemented

1. Core chat/control workflow is in place.
2. HTTP request composition now includes `agent_id` in chat payload paths where required.
3. Main form behavior includes improved agent/context refresh handling.
4. Status and interaction feedback handling have been updated for clearer operation.

### Interop Notes

1. VB6 remains compatible with the relay behavior changes made this cycle.
2. Agent identity propagation is now aligned with relay-side expectations.

---

## Open Work

1. Validate full UX flow against updated relay endpoints and error paths.
2. Improve resilience messaging for relay unavailable/timeout scenarios.
3. Expand settings and diagnostics affordances where they are still web-only.

---

## Next Steps

1. Run user-path regression on Win98SE:
   - Start/connect/send/control/reconnect
   - Permission toggle effects
   - Agent targeting behavior
2. Capture UX polish backlog from real operator sessions.
3. Document known differences between VB6 and web dashboard workflows.
