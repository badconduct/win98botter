"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Fastify = require("fastify");

test("configuration persists under the selected data directory, not application source", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "botter-config-"));
  const previous = { ...process.env };
  const app = Fastify();
  try {
    process.env.RELAY_ENV_PATH = path.join(directory, "nested", "relay.env");
    process.env.CONFIG_JSON_PATH = path.join(directory, "relay-config.json");
    delete require.cache[require.resolve("../routes/config")];
    await app.register(require("../routes/config"), {});
    const response = await app.inject({ method: "POST", url: "/api/config",
      payload: { BOT_API_URL: "http://127.0.0.1:1/v1", BOT_MODEL: "default" } });
    assert.equal(response.statusCode, 200);
    assert.match(fs.readFileSync(process.env.RELAY_ENV_PATH, "utf8"), /BOT_MODEL=default/);
    const persisted = JSON.parse(fs.readFileSync(process.env.CONFIG_JSON_PATH, "utf8"));
    assert.equal(persisted.BOT_MODEL, "default");
    assert.equal(persisted.BOT_API_URL, "http://127.0.0.1:1/v1");

    process.env.BOT_API_KEY_FILE = path.join(directory, "client-token");
    process.env.BOT_MANAGED_API_URL = "http://127.0.0.1:1/v1";
    fs.writeFileSync(process.env.BOT_API_KEY_FILE, "synthetic-test-token");
    const originalJson = fs.readFileSync(process.env.CONFIG_JSON_PATH, "utf8");
    const originalEnv = fs.readFileSync(process.env.RELAY_ENV_PATH, "utf8");
    const payload = { BOT_API_URL: "https://untrusted.invalid/v1", BOT_MODEL: "default" };
    const rejected = await app.inject({ method: "POST", url: "/api/config", payload });
    assert.equal(rejected.statusCode, 400);
    const rejectedTest = await app.inject({ method: "POST", url: "/api/config/test", payload });
    assert.equal(rejectedTest.json().ok, false);
    assert.match(rejectedTest.json().error, /BOT_MANAGED_API_URL/);
    assert.equal(fs.readFileSync(process.env.CONFIG_JSON_PATH, "utf8"), originalJson);
    assert.equal(fs.readFileSync(process.env.RELAY_ENV_PATH, "utf8"), originalEnv);
    assert.equal(process.env.BOT_API_URL, "http://127.0.0.1:1/v1");
  } finally {
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
