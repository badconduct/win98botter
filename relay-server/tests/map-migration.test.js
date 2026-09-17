"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { migrate, checksum } = require("../db/migrate-map");

test("map migration changes an empty schema once and guards its history", async () => {
  for (const rows of [[], [{version: 1, checksum}]]) {
    const queries = [];
    const client = { async query(sql) { queries.push(sql); return {rows}; } };
    const result = await migrate(client, "win98botter_owner", "win98botter_app");
    assert.equal(result.changed, rows.length === 0);
    assert.equal(queries.at(-1), "COMMIT");
    assert(queries.some(sql => sql.startsWith("REVOKE INSERT")));
    assert.equal(queries.some(sql => sql.includes("CREATE TABLE phase1_dir_entries")), rows.length === 0);
  }
});

test("map migration rolls back on checksum drift and rejects unsafe identifiers", async () => {
  const queries = [];
  const client = { async query(sql) { queries.push(sql); return {rows:[{version:1,checksum:"wrong"}]}; } };
  await assert.rejects(migrate(client,"win98botter_owner","win98botter_app"), /history differs/);
  assert.equal(queries.at(-1), "ROLLBACK");
  await assert.rejects(migrate(client,"bad;role","win98botter_app"), /identifier/);
});
