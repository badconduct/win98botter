# Win98 MCP Server Plan (Current)

## Role

`win98-mcp-server` is the Win32 primitive execution layer. It should remain small, predictable, and compatible with legacy environments while exposing callable capabilities to the relay.

---

## Current Implementation Status

### Implemented

1. Core MCP/tool dispatch runtime is operational.
2. Runtime modes now include:
   - Standard foreground mode
   - Service-style background mode (`-service`)
   - Install/uninstall style control flags (`-install`, `-uninstall`)
3. Local named-pipe IPC path is implemented.
4. Local CLI integration mode is implemented.
5. Persistent agent logging to file is implemented.
6. Logging behavior is configurable via `AGENT.INI` (`enabled`, `verbose`, `path`).

### Build Status

1. MinGW build flow was corrected for 32-bit targeting.
2. Build script/toolchain path issues were resolved.
3. Current executable was rebuilt successfully after service/IPC/logging changes.

---

## Runtime Configuration

`AGENT.INI` now supports logging control in addition to existing connection/runtime settings.

Example logging block:

```ini
[logging]
enabled=1
verbose=1
path=agent.log
```

---

## Design Constraints (Still True)

1. Keep dependencies minimal and legacy-safe.
2. Keep policy/orchestration decisions in relay, not agent.
3. Maintain predictable behavior under constrained hardware and older OS APIs.

---

## Open Work

1. Win98SE validation sweep for new service and IPC lifecycle behavior.
2. Hardening of failure handling when relay is unavailable/intermittent.
3. Better log file management strategy (size cap/rotation policy).
4. Additional coverage tests for CLI/pipe command handling edge cases.

---

## Next Steps

1. Execute regression matrix on Win98SE (boot, connect, command loop, disconnect, restart).
2. Verify install/uninstall and service mode idempotency.
3. Confirm IPC mode stability under repeated high-frequency requests.
4. Finalize operator troubleshooting notes based on observed behavior.
