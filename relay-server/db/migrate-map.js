"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");
const { postgresConfig } = require("./postgres-config");

const migration = fs.readFileSync(path.join(__dirname, "migrations", "001-phase1-map.sql"), "utf8");
const checksum = crypto.createHash("sha256").update(migration.replace(/\r\n/g, "\n")).digest("hex");

function identifier(value) {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(value || "")) throw new Error("Invalid migration role identifier");
  return '"' + value + '"';
}

async function migrate(client, owner, runtime) {
  const ownerSql = identifier(owner);
  const runtimeSql = identifier(runtime);
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext('win98botter-map'))");
    await client.query(`SET LOCAL ROLE ${ownerSql}`);
    await client.query(`CREATE TABLE IF NOT EXISTS public.relay_schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // The platform grants DML on new tables by default, but the runtime may
    // only READ the migration ledger. It must never advance its own version.
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON public.relay_schema_migrations FROM ${runtimeSql}`);
    await client.query(`GRANT SELECT ON public.relay_schema_migrations TO ${runtimeSql}`);
    const { rows } = await client.query("SELECT version, checksum FROM public.relay_schema_migrations ORDER BY version");
    if (rows.length > 1 || (rows.length && (rows[0].version !== 1 || rows[0].checksum !== checksum))) {
      throw new Error("Migration history differs from the reviewed image");
    }
    const changed = rows.length === 0;
    if (changed) {
      await client.query(migration);
      await client.query("INSERT INTO public.relay_schema_migrations(version,checksum) VALUES (1,$1)", [checksum]);
    }
    await client.query("COMMIT");
    return { changed, version: 1, checksum };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const env = process.env;
  const config = postgresConfig({ phase1PgSchemaMode: "external", phase1PgSsl: "1",
    phase1PgHost: env.PHASE1_PG_HOST, phase1PgPort: env.PHASE1_PG_PORT || "5432",
    phase1PgDatabase: env.PHASE1_PG_DATABASE, phase1PgUser: env.PHASE1_PG_USER,
    phase1PgPasswordFile: env.PHASE1_PG_PASSWORD_FILE, phase1PgCaFile: env.PHASE1_PG_CA_FILE,
    phase1PgUrl: env.PHASE1_PG_URL });
  const client = new Client(config);
  try {
    await client.connect();
    const result = await migrate(client, env.MIGRATION_OWNER_ROLE, env.MIGRATION_RUNTIME_ROLE);
    console.log(JSON.stringify(result));
  } finally { await client.end(); }
}

if (require.main === module) main().catch(() => {
  console.error("Map schema migration failed; no credentials or SQL parameters logged. Existing transaction rolled back.");
  process.exitCode = 1;
});
module.exports = { migrate, checksum };
