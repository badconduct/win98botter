"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { postgresConfig } = require("../db/postgres-config");
const { createPhase1Store } = require("../db/phase1-store");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "botter-pg-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const password = path.join(directory, "password");
  const ca = path.join(directory, "ca.crt");
  fs.writeFileSync(password, "synthetic-test-password\n");
  fs.writeFileSync(ca, "synthetic-test-ca");
  return { phase1PgEnabled: "1", phase1PgSchemaMode: "external",
    phase1PgSsl: "1", phase1PgCaFile: ca, phase1PgPasswordFile: password,
    phase1PgHost: "postgresql", phase1PgDatabase: "win98botter",
    phase1PgUser: "win98botter_app" };
}

test("managed PostgreSQL verifies TLS and reads its mounted password", t => {
  const config = postgresConfig(fixture(t));
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.ca, "synthetic-test-ca");
  assert.equal(config.password, "synthetic-test-password");
  assert.equal(config.max, 5);
});

test("managed PostgreSQL refuses missing trust, plaintext and URL overrides", t => {
  const config = fixture(t);
  for (const change of [{ phase1PgSsl: "0" }, { phase1PgCaFile: "" },
    { phase1PgPasswordFile: "" }, { phase1PgSchemaMode: "externl" },
    { phase1PgUrl: "postgresql://localhost/db?sslmode=no-verify" }]) {
    assert.throws(() => postgresConfig({ ...config, ...change }));
  }
  fs.writeFileSync(config.phase1PgPasswordFile, "\n");
  assert.throws(() => postgresConfig(config), /password file/);
  fs.unlinkSync(config.phase1PgPasswordFile);
  assert.throws(() => postgresConfig(config), /ENOENT/);
});

test("external schema startup performs reads only and propagates missing-schema failures", async t => {
  const queries = [];
  class FakePool {
    async query(sql) { queries.push(sql); return { rows: [] }; }
    async end() {}
  }
  const config = fixture(t);
  const store = createPhase1Store(config, { info() {} }, FakePool);
  await store.init();
  assert.equal(queries.length, 3);
  for (const sql of queries) assert.match(sql, /^SELECT .+ LIMIT 0$/);
  class MissingSchemaPool extends FakePool {
    async query() { throw new Error("missing schema"); }
  }
  await assert.rejects(createPhase1Store(config, { info() {} }, MissingSchemaPool).init(), /missing schema/);
});

test("legacy initialization remains available; enabling TLS never disables verification", () => {
  assert.equal(postgresConfig({ phase1PgSsl: "0" }).ssl, false);
  assert.equal(postgresConfig({ phase1PgSsl: "1" }).ssl.rejectUnauthorized, true);
  assert.equal(createPhase1Store({}, {}).enabled, false);
});
