"use strict";

const fs = require("node:fs");

function postgresConfig(config) {
  const mode = config.phase1PgSchemaMode || "legacy";
  if (!["legacy", "external"].includes(mode)) {
    throw new Error("PHASE1_PG_SCHEMA_MODE must be legacy or external");
  }
  const tls = ["1", "true", "yes", "on"].includes(String(config.phase1PgSsl).toLowerCase());
  if (mode === "external" && (!tls || !config.phase1PgCaFile || !config.phase1PgPasswordFile)) {
    throw new Error("External PostgreSQL requires verified TLS, a CA file and a password file");
  }
  // A pg connection URI can override the explicitly configured TLS object.
  if (config.phase1PgUrl && (mode === "external" || config.phase1PgPasswordFile || config.phase1PgCaFile)) {
    throw new Error("Use discrete PostgreSQL settings with file credentials or a custom CA");
  }
  let password = config.phase1PgPassword || undefined;
  if (config.phase1PgPasswordFile) {
    password = fs.readFileSync(config.phase1PgPasswordFile, "utf8").trim();
    if (!password || /[\r\n]/.test(password)) throw new Error("Invalid PostgreSQL password file");
  }
  return {
    connectionString: config.phase1PgUrl || undefined,
    host: config.phase1PgHost || undefined,
    port: config.phase1PgPort ? Number(config.phase1PgPort) : undefined,
    database: config.phase1PgDatabase || undefined,
    user: config.phase1PgUser || undefined,
    password,
    ssl: tls ? {
      rejectUnauthorized: true,
      ...(config.phase1PgCaFile ? { ca: fs.readFileSync(config.phase1PgCaFile, "utf8") } : {}),
    } : false,
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  };
}

module.exports = { postgresConfig };
