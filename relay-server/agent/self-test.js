"use strict";

const {
  schemaList,
  advertisedToolNames,
  filterSchemasForAgent,
} = require("../win98/tools");

function clampProbePath(agentInfo) {
  const startup = (agentInfo && agentInfo.startupCheck) || {};
  return startup.permissions_ini || "C:\\WIN98BOTTER\\permissions.ini";
}

function buildSafeProbes(agentInfo) {
  const startup = (agentInfo && agentInfo.startupCheck) || {};
  const filePath = clampProbePath(agentInfo);
  const baseDir = startup.base_dir || "C:\\WIN98BOTTER";
  return [
    { name: "get_system_info", input: {} },
    { name: "get_disk_info", input: {} },
    { name: "get_screen_resolution", input: {} },
    { name: "list_processes", input: {} },
    { name: "get_audio_devices", input: {} },
    { name: "get_midi_devices", input: {} },
    { name: "get_window_list", input: {} },
    { name: "file_exists", input: { path: filePath } },
    { name: "get_file_info", input: { path: filePath } },
    { name: "read_file_range", input: { path: filePath, offset: 0, length: 256 } },
    { name: "tail_file", input: { path: filePath, length: 256 } },
    { name: "get_file_hash", input: { path: filePath } },
    { name: "ini_read", input: { path: filePath, section: "tools", key: "read_file" } },
    { name: "list_directory", input: { path: baseDir } },
    {
      name: "read_registry",
      input: {
        hive: "HKLM",
        key: "Software\\Microsoft\\Windows\\CurrentVersion",
        value_name: "ProgramFilesDir",
      },
    },
    { name: "list_installed_apps", input: { max_results: 100 } },
    { name: "list_startup_items", input: { max_results: 100 } },
    { name: "list_devices", input: { max_results: 100 } },
    { name: "get_network_config", input: {} },
    { name: "dns_lookup", input: { host: "localhost" } },
    { name: "ping_host", input: { host: "127.0.0.1", timeout_ms: 2000 } },
    {
      name: "list_network_connections",
      input: { protocol: "all", include_listening: true, max_results: 100 },
    },
  ];
}

function normalizeResult(result) {
  if (typeof result !== "string") return result;
  const trimmed = result.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return result;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return result;
  }
}

function classifyResult(result) {
  if (result && typeof result === "object") {
    if (result.supported === false) return "unsupported";
    if (result.error || result.permission_denied || result.success === false) {
      return "failed";
    }
  }
  return "successful";
}

async function runAgentSelfTest(entry, logger) {
  if (!entry || !entry.connection || !entry.connection.connected) {
    throw new Error("Win98 agent is not connected");
  }

  const connection = entry.connection;
  const started = Date.now();
  const listed = await connection.listTools();
  if (!connection.agentInfo) connection.agentInfo = {};
  connection.agentInfo.tools = Array.isArray(listed && listed.tools)
    ? listed.tools
    : [];

  const relaySchemas = schemaList();
  const advertised = advertisedToolNames(connection.agentInfo) || new Set();
  const agentSchemas = filterSchemasForAgent(relaySchemas, connection.agentInfo);
  const allowedSchemas = entry.permissions.filterSchemas(agentSchemas);
  const allowed = new Set(allowedSchemas.map((schema) => schema.name));
  const advertisedKnown = relaySchemas
    .map((schema) => schema.name)
    .filter((name) => advertised.has(name));
  const blocked = relaySchemas
    .map((schema) => schema.name)
    .filter((name) => !entry.permissions.isAllowed(name));
  const unsupportedByAgent = relaySchemas
    .map((schema) => schema.name)
    .filter(
      (name) => entry.permissions.isAllowed(name) && !advertised.has(name),
    );
  const unmodeledByRelay = [...advertised].filter(
    (name) => !relaySchemas.some((schema) => schema.name === name),
  );

  const probeResults = [];
  for (const probe of buildSafeProbes(connection.agentInfo)) {
    if (!allowed.has(probe.name)) continue;
    const probeStarted = Date.now();
    let result;
    let status;
    try {
      result = normalizeResult(await connection.callTool(probe.name, probe.input));
      status = classifyResult(result);
    } catch (error) {
      status = "failed";
      result = { error: error.message };
    }
    probeResults.push({
      tool: probe.name,
      status,
      duration_ms: Date.now() - probeStarted,
      result,
    });
  }

  const count = (status) =>
    probeResults.filter((probe) => probe.status === status).length;
  const report = {
    deterministic: true,
    llm_calls: 0,
    tokens_used: 0,
    agent_version:
      connection.agentInfo.serverInfo && connection.agentInfo.serverInfo.version,
    duration_ms: Date.now() - started,
    counts: {
      relay_schemas: relaySchemas.length,
      advertised: advertised.size,
      advertised_known: advertisedKnown.length,
      relay_allowed: allowed.size,
      blocked: blocked.length,
      unsupported_by_agent: unsupportedByAgent.length,
      unmodeled_by_relay: unmodeledByRelay.length,
      tested: probeResults.length,
      successful: count("successful"),
      failed: count("failed"),
      unsupported_runtime: count("unsupported"),
    },
    advertised: [...advertised].sort(),
    relay_allowed: [...allowed].sort(),
    blocked: blocked.sort(),
    unsupported_by_agent: unsupportedByAgent.sort(),
    unmodeled_by_relay: unmodeledByRelay.sort(),
    probes: probeResults,
  };

  if (logger) {
    logger.info(
      { agentId: connection.agentId, counts: report.counts },
      "Deterministic agent self-test completed",
    );
  }
  return report;
}

module.exports = {
  buildSafeProbes,
  normalizeResult,
  classifyResult,
  runAgentSelfTest,
};
