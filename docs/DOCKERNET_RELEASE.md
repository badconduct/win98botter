# Dockernet relay release

This release packages the existing relay/UI and current v0.15 tool contract;
it is not the winGPT98 redesign. Existing native/VB permission changes are
included because the relay's current contract tests depend on them. No native
executable is published or installed by this workflow.

## Pipeline

Feature PR -> secret/history scan -> Linux container build -> unit/contract
tests -> actual PostgreSQL migration and runtime tests -> hardened container
replacement/SQLite tests -> high/critical vulnerability gate -> human merge.
The main-branch workflow publishes the exact validated image (not a rebuild)
to `ghcr.io/badconduct/win98botter:sha-<commit>` and records its digest.
An infrastructure PR then promotes that digest. Merge never deploys Dockernet.

The old repository tracked node_modules, local INI/env files, logs and an agent
binary. This PR stops tracking those artifacts. Historical secret scanning
does not prove credentials were never present; rotate any formerly committed
real credential. Original workstation files and its Git staging remain intact
in the separate working checkout.

## Runtime

- Build `relay-server/Dockerfile.gateway`. No local Codex installation/login.
- npm/Yarn are build-only, not shipped in the final runtime. The pinned base's
  OpenSSL packages are upgraded to the explicitly pinned security revision;
  CI scans the resulting runtime without suppressing fixable high/critical CVEs.
- Persistent `/data`: SQLite `relay.db`, settings, and `staging/`.
- Shared PostgreSQL: dedicated database/owner/migrator/runtime roles. No new
  PostgreSQL container, no exposed database port, no conversion of SQLite.
- `PHASE1_PG_ENABLED=1`, `PHASE1_PG_SCHEMA_MODE=external`,
  `PHASE1_PG_HOST=postgresql`, `PHASE1_PG_DATABASE=win98botter`,
  `PHASE1_PG_USER=win98botter_app`, `PHASE1_PG_SSL=1`.
- Mount `PHASE1_PG_CA_FILE` and `PHASE1_PG_PASSWORD_FILE`; unset
  `PHASE1_PG_URL`. Keep the migrator credential out of the running relay.
- Shared AI: trusted API `/v1` URL, `BOT_MODEL=default`, `BOT_AI_PROFILE`,
  and `BOT_API_KEY_FILE` containing only the client token, never admin token.
  Set `BOT_MANAGED_API_URL` to that same trusted `/v1` URL in deployment config.
  With a file-backed token, Setup and connection tests cannot redirect it to a
  different endpoint. Use verified HTTPS on Dockernet; do not disable TLS checks.
- Run always on, nonroot, with read-only application files, dropped
  capabilities, no-new-privileges, bounded logs/resources and persistent data.
- Set `WIN98_ALLOWED_PEERS` to comma-separated allowed IPv4 agent addresses.
  Dockernet must explicitly set it; absent configuration retains legacy LAN
  behavior. Rejected peers are disconnected before agent registration.
- The application HTTP API is not independently authenticated: protect all
  routes at Traefik and do not publish port 3000. Native TCP is a separate
  trusted-LAN management channel and needs explicit ingress restrictions.

## Schema migration

Run the promoted image with `node db/migrate-map.js` on the internal database
network. Set the same host/database/CA settings, but use
`PHASE1_PG_USER=win98botter_migrator` and a temporary read-only mount for its
password file. Set `MIGRATION_OWNER_ROLE=win98botter_owner` and
`MIGRATION_RUNTIME_ROLE=win98botter_app`.

The command connects with verified TLS, takes a transaction lock, assumes
the owner role, records a normalized SQL checksum and applies schema 1 once.
Its JSON result reports `changed`; the next run must return false. A checksum
mismatch or unexpected version halts deployment. The runtime cannot alter the
ledger. Do not delete the ledger or tables to bypass a failed migration.

The initial migration is forward-only. Start empty as approved; do not delete
the old workstation data. After new data is written, keep the compatible image
or apply a reviewed forward fix rather than dropping the database on rollback.

## Verification and remaining gates

Local Linux image: 42 tests passed, PostgreSQL 18.6 migration/runtime and
second-run acceptance passed, hardened UI/health and SQLite/config replacement
persistence passed. Disposable fixtures were removed. No live AI inference or
Dockernet deployment is part of those tests.

Still required: green CI for the final PR commit, human merge, digest promotion,
Ansible secrets/provisioning/migration/deployment, real-agent and shared-AI
acceptance, encrypted PostgreSQL restore test, separate relay data backup,
second-run deployment idempotence, and explicit cutover. Existing native INI
remains unchanged until the server is ready.
