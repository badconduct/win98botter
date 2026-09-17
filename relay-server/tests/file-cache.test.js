"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const AgentLoop = require("../agent/loop");
const PermissionsManager = require("../agent/permissions");
const queries = require("../db/queries");
const { getDb, initDb } = require("../db/schema");

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

test("verified unchanged text reads reuse cached content without a remote read", async () => {
  initDb();
  const agentId = "cache-agent";
  const sessionId = "cache-session";
  const filePath = "C:\\WIN98BOTTER\\TESTS\\CACHE.TXT";
  const content = "cache marker\r\n";
  const modified = "2026-08-21 12:00:00";

  queries.createSession(sessionId, agentId, "192.168.1.140", "default");
  queries.recordFileLocation(agentId, "CACHE.TXT", filePath);
  const record = queries.getFileLocationByPath(agentId, filePath);
  queries.storeFileContent(
    record.id,
    null,
    null,
    content,
    Buffer.byteLength(content),
  );
  queries.updateFileMetadata(
    record.id,
    "text/plain",
    true,
    Buffer.byteLength(content),
    modified,
  );

  const remoteCalls = [];
  const win98 = {
    agentId,
    connected: true,
    async callTool(name) {
      remoteCalls.push(name);
      assert.equal(name, "get_file_info");
      return {
        exists: true,
        is_directory: false,
        size_bytes: Buffer.byteLength(content),
        modified,
      };
    },
  };
  const staging = {
    async stageAndParse() {
      throw new Error("staging should not run for a verified cache hit");
    },
  };
  const loop = new AgentLoop(
    { isAnthropic: () => false },
    win98,
    staging,
    new PermissionsManager(),
    logger(),
    { selectedAgentId: agentId },
  );

  const result = await loop._executeToolCall(
    { id: "read-1", name: "read_file", input: { path: filePath } },
    sessionId,
  );

  assert.equal(result.cache_hit, true);
  assert.equal(result.verified_live, true);
  assert.equal(result.content, content);
  assert.deepEqual(remoteCalls, ["get_file_info"]);
});

test("successful mutation invalidates cached file content", async () => {
  initDb();
  const agentId = "mutation-agent";
  const sessionId = "mutation-session";
  const filePath = "C:\\WIN98BOTTER\\TESTS\\MUTATE.TXT";

  queries.createSession(sessionId, agentId, "192.168.1.140", "default");
  queries.recordFileLocation(agentId, "MUTATE.TXT", filePath);
  const record = queries.getFileLocationByPath(agentId, filePath);
  queries.storeFileContent(record.id, null, null, "old", 3);
  queries.updateFileMetadata(
    record.id,
    "text/plain",
    true,
    3,
    "2026-08-21 12:00:00",
  );

  const permissions = new PermissionsManager();
  permissions.update({ file_write: true });
  const loop = new AgentLoop(
    { isAnthropic: () => false },
    {
      agentId,
      connected: true,
      async callTool(name) {
        assert.equal(name, "write_file");
        return { success: true, bytes_written: 3, backup_path: "backup.bak" };
      },
    },
    {},
    permissions,
    logger(),
    { selectedAgentId: agentId },
  );

  await loop._executeToolCall(
    {
      id: "write-1",
      name: "write_file",
      input: { path: filePath, content: "new" },
    },
    sessionId,
  );

  assert.equal(queries.getLatestFullFileContent(record.id), undefined);
});

test("v0.15 CRC32 mismatch invalidates a same-size same-timestamp cache entry", async () => {
  initDb();
  const agentId = "hash-cache-agent";
  const sessionId = "hash-cache-session";
  const filePath = "C:\\WIN98BOTTER\\TESTS\\HASH.TXT";
  const content = "old!";
  const modified = "2026-08-21 12:00:00";

  queries.createSession(sessionId, agentId, "192.168.1.140", "default");
  queries.recordFileLocation(agentId, "HASH.TXT", filePath);
  const record = queries.getFileLocationByPath(agentId, filePath);
  queries.storeFileContent(record.id, null, null, content, 4);
  queries.updateFileMetadata(record.id, "text/plain", true, 4, modified);
  queries.updateFileRemoteHash(record.id, "crc32", "AAAAAAAA");

  const calls = [];
  const win98 = {
    agentId,
    connected: true,
    agentInfo: {
      tools: ["read_file", "get_file_info", "get_file_hash"],
    },
    async callTool(name) {
      calls.push(name);
      if (name === "get_file_info") {
        return { exists: true, size_bytes: 4, modified };
      }
      if (name === "get_file_hash") {
        return { algorithm: "crc32", hash: "BBBBBBBB" };
      }
      throw new Error(`unexpected call: ${name}`);
    },
  };
  const staging = {
    async stageAndParse() {
      return {
        content: "new!",
        staged_bytes: 4,
        file_size: 4,
        modified,
        mime_type: "text/plain",
        is_text: true,
      };
    },
  };
  const loop = new AgentLoop(
    { isAnthropic: () => false },
    win98,
    staging,
    new PermissionsManager(),
    logger(),
    { selectedAgentId: agentId },
  );

  const result = await loop._executeToolCall(
    { id: "read-hash", name: "read_file", input: { path: filePath } },
    sessionId,
  );

  assert.notEqual(result.cache_hit, true);
  assert.deepEqual(calls, [
    "get_file_info",
    "get_file_hash",
    "get_file_hash",
  ]);
  const refreshed = queries.getFileLocationByPath(agentId, filePath);
  assert.equal(refreshed.remote_content_hash, "BBBBBBBB");
});

test("path verification refresh is case-insensitive", () => {
  initDb();
  queries.recordFileLocation("case-agent", "WIN.INI", "C:\\WINDOWS\\WIN.INI");
  queries.updateFileLocationVerification(
    "case-agent",
    "WIN.INI",
    "C:\\WINDOWS\\WIN.INI",
    false,
  );
  queries.recordFileLocation("case-agent", "win.ini", "c:\\windows\\win.ini");

  const row = queries.getFileLocationByPath(
    "case-agent",
    "C:\\WINDOWS\\WIN.INI",
  );
  const count = getDb()
    .prepare("SELECT COUNT(*) AS n FROM file_locations WHERE agent_id = ?")
    .get("case-agent").n;
  assert.equal(count, 1);
  assert.equal(row.exists_flag, 1);
});

test("central prompt settings persist per canonical agent", () => {
  initDb();
  queries.saveAgentPromptSettings(
    "host:h4x0r",
    { investigation_first: false },
    "Call this machine RetroLab.",
  );
  const stored = queries.getAgentPromptSettings("host:h4x0r");
  assert.equal(stored.flags.investigation_first, false);
  assert.equal(stored.customPrompt, "Call this machine RetroLab.");
});

test("repeated identical staging failures are audited and stop after two attempts", async () => {
  initDb();
  const agentId = "repeat-failure-agent";
  const sessionId = "repeat-failure-session";
  const filePath = "C:\\WIN98BOTTER\\permissions.ini";
  queries.createSession(sessionId, agentId, "192.168.1.140", "default");

  let llmCalls = 0;
  const llm = {
    apiUrl: "codex://local",
    model: "default",
    isAnthropic: () => false,
    async call() {
      llmCalls++;
      const id = `repeat-${llmCalls}`;
      return {
        stop_reason: "tool_use",
        text: "",
        tool_calls: [{ id, name: "read_file", input: { path: filePath } }],
        _openai_message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: filePath }),
              },
            },
          ],
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
  const win98 = {
    agentId,
    agentInfo: null,
    connected: true,
    async callTool(name) {
      assert.equal(name, "get_file_info");
      return {
        exists: true,
        is_directory: false,
        size_bytes: 10,
        modified: "2026-08-21 12:00:00",
      };
    },
  };
  const staging = {
    async stageAndParse() {
      throw new Error("simulated staging failure");
    },
  };
  const loop = new AgentLoop(
    llm,
    win98,
    staging,
    new PermissionsManager(),
    logger(),
    { selectedAgentId: agentId },
  );

  const result = await loop.run(sessionId, "Read the permissions file", 80000);
  const audited = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ? AND tool_name = 'read_file'",
    )
    .get(sessionId).n;

  assert.equal(llmCalls, 2);
  assert.equal(result.tool_calls_made, 2);
  assert.match(result.response, /failed twice/i);
  assert.equal(audited, 2);
});
