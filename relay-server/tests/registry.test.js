"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const AgentRegistry = require("../win98/registry");

test("registry preserves the per-agent staging manager", () => {
  const registry = new AgentRegistry();
  const staging = { stageAndParse() {} };
  registry.register("host:h4x0r", {
    connection: { connected: true },
    watchdog: null,
    agentLoop: null,
    permissions: {},
    staging,
    canonicalAgentId: "host:h4x0r",
  });

  assert.equal(registry.get("host:h4x0r").staging, staging);
  assert.equal(registry.getDefault().staging, staging);
});
