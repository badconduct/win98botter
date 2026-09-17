"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const PermissionsManager = require("../agent/permissions");
const {
  buildSafeProbes,
  classifyResult,
  normalizeResult,
  runAgentSelfTest,
} = require("../agent/self-test");

test("self-test probe set is read-only and excludes clipboard content", () => {
  const probes = buildSafeProbes({
    startupCheck: {
      base_dir: "C:\\BOT",
      permissions_ini: "C:\\BOT\\permissions.ini",
    },
  });
  const names = probes.map((probe) => probe.name);
  assert.equal(names.includes("read_clipboard"), false);
  assert.equal(names.includes("run_command"), false);
  assert.equal(names.includes("write_file"), false);
  assert.equal(names.includes("get_file_hash"), true);
  assert.equal(probes.find((probe) => probe.name === "tail_file").input.path, "C:\\BOT\\permissions.ini");
});

test("self-test result normalization and classification are deterministic", () => {
  assert.deepEqual(normalizeResult('{"supported":false}'), { supported: false });
  assert.equal(classifyResult({ supported: false }), "unsupported");
  assert.equal(classifyResult({ error: "nope" }), "failed");
  assert.equal(classifyResult({ success: true }), "successful");
});

test("self-test reports advertised, blocked, unsupported, and probe outcomes without LLM use", async () => {
  const advertised = [
    "get_system_info",
    "get_disk_info",
    "get_screen_resolution",
    "file_exists",
    "get_file_info",
    "list_directory",
  ];
  const connection = {
    connected: true,
    agentId: "host:test",
    agentInfo: {
      serverInfo: { version: "0.14" },
      startupCheck: { base_dir: "C:\\BOT", permissions_ini: "C:\\BOT\\permissions.ini" },
      tools: advertised.map((name) => ({ name })),
    },
    async listTools() {
      return { tools: advertised.map((name) => ({ name })) };
    },
    async callTool(name) {
      if (name === "get_disk_info") return { error: "probe failure" };
      return { success: true };
    },
  };
  const permissions = new PermissionsManager();
  permissions.update({ read_file: true });
  const report = await runAgentSelfTest({ connection, permissions });

  assert.equal(report.llm_calls, 0);
  assert.equal(report.tokens_used, 0);
  assert.equal(report.counts.advertised, advertised.length);
  assert.equal(report.counts.tested, advertised.length);
  assert.equal(report.counts.failed, 1);
  assert.equal(report.unsupported_by_agent.includes("get_file_hash"), true);
  assert.equal(report.blocked.includes("read_clipboard"), true);
});
