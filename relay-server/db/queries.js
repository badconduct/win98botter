"use strict";

const { getDb } = require("./schema");

function now() {
  return new Date().toISOString();
}

// ── Agents ────────────────────────────────────────────────────────────────────

function upsertAgent(agentId, hostname, ipAddress) {
  const n = now();
  getDb()
    .prepare(
      `INSERT INTO agents (agent_id, hostname, ip_address, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         hostname   = excluded.hostname,
         ip_address = excluded.ip_address,
         last_seen  = excluded.last_seen`,
    )
    .run(agentId, hostname || null, ipAddress || null, n, n);
}

function listAgents() {
  return getDb().prepare("SELECT * FROM agents ORDER BY last_seen DESC").all();
}

function getAgent(agentId) {
  return getDb()
    .prepare("SELECT * FROM agents WHERE agent_id = ?")
    .get(agentId);
}

function deleteAgent(agentId) {
  getDb().prepare("DELETE FROM agents WHERE agent_id = ?").run(agentId);
}

// ── Sessions ──────────────────────────────────────────────────────────────────

function createSession(id, agentId, win98Host, llmModel) {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, agent_id, started_at, win98_host, llm_model) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, agentId || null, now(), win98Host || null, llmModel || null);
}

function updateSessionTokens(sessionId, additionalTokens) {
  getDb()
    .prepare("UPDATE sessions SET token_total = token_total + ? WHERE id = ?")
    .run(additionalTokens, sessionId);
}

function getSession(sessionId) {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
}

function getLatestSessionByAgentId(agentId) {
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1",
    )
    .get(agentId);
}

// ── Messages ──────────────────────────────────────────────────────────────────

function saveMessage(sessionId, role, content) {
  getDb()
    .prepare(
      "INSERT INTO messages (session_id, timestamp, role, content) VALUES (?, ?, ?, ?)",
    )
    .run(
      sessionId,
      now(),
      role,
      typeof content === "string" ? content : JSON.stringify(content),
    );
}

function getRecentMessages(sessionId, limit) {
  limit = limit || 50;
  return getDb()
    .prepare(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
    )
    .all(sessionId, limit)
    .reverse();
}

function getAllMessages(sessionId) {
  return getDb()
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC")
    .all(sessionId);
}

// ── Tool calls ────────────────────────────────────────────────────────────────

function saveToolCall(sessionId, toolName, argsJson, resultJson, durationMs) {
  return getDb()
    .prepare(
      "INSERT INTO tool_calls (session_id, timestamp, tool_name, args_json, result_json, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      sessionId,
      now(),
      toolName,
      argsJson,
      resultJson || null,
      durationMs || null,
    ).lastInsertRowid;
}

function getToolCalls(sessionId, limit) {
  limit = limit || 100;
  return getDb()
    .prepare(
      "SELECT * FROM tool_calls WHERE session_id = ? ORDER BY id DESC LIMIT ?",
    )
    .all(sessionId, limit)
    .reverse();
}

// ── File changes ──────────────────────────────────────────────────────────────

function saveFileChange(
  sessionId,
  action,
  win98Path,
  backupPath,
  previousValue,
  newValue,
) {
  return getDb()
    .prepare(
      "INSERT INTO file_changes (session_id, timestamp, action, win98_path, backup_path, previous_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      sessionId,
      now(),
      action,
      win98Path,
      backupPath || null,
      previousValue || null,
      newValue || null,
    ).lastInsertRowid;
}

function getFileChanges(sessionId) {
  return getDb()
    .prepare("SELECT * FROM file_changes WHERE session_id = ? ORDER BY id ASC")
    .all(sessionId);
}

function getFileChangeById(changeId) {
  return getDb()
    .prepare("SELECT * FROM file_changes WHERE id = ?")
    .get(changeId);
}

module.exports = {
  upsertAgent,
  listAgents,
  getAgent,
  deleteAgent,
  createSession,
  updateSessionTokens,
  getSession,
  getLatestSessionByAgentId,
  saveMessage,
  getRecentMessages,
  getAllMessages,
  saveToolCall,
  getToolCalls,
  saveFileChange,
  getFileChanges,
  getFileChangeById,
};
