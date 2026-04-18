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

function createSession(id, agentId, win98Host, llmModel, source) {
  const sessionSource = String(source || "administrator").toLowerCase();
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, agent_id, source, started_at, win98_host, llm_model) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      agentId || null,
      sessionSource,
      now(),
      win98Host || null,
      llmModel || null,
    );
}

function updateSessionTokens(sessionId, additionalTokens) {
  getDb()
    .prepare("UPDATE sessions SET token_total = token_total + ? WHERE id = ?")
    .run(additionalTokens, sessionId);
}

function getSession(sessionId) {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
}

function getLatestSessionByAgentId(agentId, source) {
  if (source) {
    return getDb()
      .prepare(
        "SELECT * FROM sessions WHERE agent_id = ? AND COALESCE(source, 'administrator') = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(agentId, String(source).toLowerCase());
  }

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

// ── File Location Cache ───────────────────────────────────────────────────────

/**
 * Get known locations for a file by name on a specific agent.
 * Returns most recently verified locations first.
 */
function getKnownFileLocations(agentId, fileName) {
  return getDb()
    .prepare(
      `SELECT discovered_path, first_found_at, last_verified, exists_flag
       FROM file_locations 
       WHERE agent_id = ? AND file_name = ?
       ORDER BY last_verified DESC`,
    )
    .all(agentId, fileName);
}

/**
 * Record a newly discovered file location.
 * If the location was already known, this is a no-op (UNIQUE constraint handles it).
 */
function recordFileLocation(agentId, fileName, discPath) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO file_locations 
       (agent_id, file_name, discovered_path, first_found_at, last_verified, exists_flag)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .run(agentId, fileName, discPath, now(), now());
}

/**
 * Look up a cached file location by its full discovered path.
 */
function getFileLocationByPath(agentId, discPath) {
  return getDb()
    .prepare(
      `SELECT *
       FROM file_locations
       WHERE agent_id = ? AND discovered_path = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(agentId, discPath);
}

/**
 * Update the verification status and timestamp for a file location.
 * Used when the LLM has verified a file still exists (or no longer exists).
 */
function updateFileLocationVerification(agentId, fileName, discPath, exists) {
  getDb()
    .prepare(
      `UPDATE file_locations 
       SET last_verified = ?, exists_flag = ?
       WHERE agent_id = ? AND file_name = ? AND discovered_path = ?`,
    )
    .run(now(), exists ? 1 : 0, agentId, fileName, discPath);
}

/**
 * Mark all known locations for a file as non-existent (e.g., after thorough search failed).
 * Useful when file search has been exhausted and no location was found.
 */
function markFileLocationsNotFound(agentId, fileName) {
  getDb()
    .prepare(
      `UPDATE file_locations 
       SET exists_flag = 0, last_verified = ?
       WHERE agent_id = ? AND file_name = ?`,
    )
    .run(now(), agentId, fileName);
}

// ── File Contents Storage ─────────────────────────────────────────────────────

/**
 * Store or update file content for a specific line range.
 * Supports partial reads: if lines 1-10 are known and we read lines 50-60,
 * both ranges are stored separately and can be merged for display.
 * For binary files, content may be a base64 or summary string while MIME/type
 * metadata lives on the related file_locations row.
 */
function storeFileContent(
  fileLocationId,
  lineStart,
  lineEnd,
  content,
  bytesRead,
) {
  const contentHash = require("crypto")
    .createHash("sha256")
    .update(content)
    .digest("hex");

  getDb()
    .prepare(
      `INSERT INTO file_contents 
       (file_location_id, line_start, line_end, content, content_hash, bytes_read, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_location_id, line_start, line_end) DO UPDATE SET
         content = excluded.content,
         content_hash = excluded.content_hash,
         bytes_read = excluded.bytes_read,
         updated_at = excluded.updated_at`,
    )
    .run(
      fileLocationId,
      lineStart || null,
      lineEnd || null,
      content,
      contentHash,
      bytesRead,
      now(),
    );
}

/**
 * Get all stored content ranges for a file.
 * Returns all ranges so caller can determine what's been cached and what gaps exist.
 */
function getFileContentRanges(fileLocationId) {
  return getDb()
    .prepare(
      `SELECT line_start, line_end, bytes_read, content_hash, updated_at
       FROM file_contents
       WHERE file_location_id = ?
       ORDER BY line_start ASC, line_end ASC`,
    )
    .all(fileLocationId);
}

/**
 * Get cached content for a specific line range.
 * Returns all overlapping ranges and their content.
 */
function getCachedFileContent(fileLocationId, lineStart, lineEnd) {
  return getDb()
    .prepare(
      `SELECT line_start, line_end, content, bytes_read 
       FROM file_contents
       WHERE file_location_id = ?
         AND ((line_start IS NULL AND line_end IS NULL) 
              OR (? IS NULL OR line_start <= ?)
              OR (? IS NULL OR line_end >= ?))
       ORDER BY line_start ASC`,
    )
    .all(fileLocationId, lineEnd, lineEnd, lineStart, lineStart);
}

/**
 * Get the first N bytes of a file (most commonly requested range).
 */
function getFirstBytesOfFile(fileLocationId, limit = 256) {
  return getDb()
    .prepare(
      `SELECT content, bytes_read, updated_at
       FROM file_contents
       WHERE file_location_id = ?
         AND (line_start IS NULL OR line_start = 1)
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(fileLocationId);
}

/**
 * Update MIME type and text flag for a file location.
 * Called after file_exists or read_file to indicate file type.
 */
function updateFileMetadata(
  fileLocationId,
  mimeType,
  isTextFile,
  fileSizeBytes,
) {
  getDb()
    .prepare(
      `UPDATE file_locations
       SET mime_type = ?, is_text_file = ?, file_size_bytes = ?
       WHERE id = ?`,
    )
    .run(mimeType, isTextFile ? 1 : 0, fileSizeBytes, fileLocationId);
}

// ── Directory Tree Building ───────────────────────────────────────────────────

/**
 * Record a discovered file or directory in the tree.
 * Automatically extracts parent path from the full path.
 */
function recordDirectoryTreeEntry(agentId, fullPath, isDirectory) {
  // Use Windows-style path parsing regardless of host OS.
  const normalized = String(fullPath || "").replace(/\//g, "\\");
  const parts = normalized.split("\\").filter(Boolean);

  if (parts.length === 0) return;

  const fileName = parts[parts.length - 1];
  const drive = parts[0].endsWith(":") ? parts[0] : "C:";
  const parentParts = parts.slice(0, -1);
  const parentPath = parentParts.length > 0 ? parentParts.join("\\") : drive;

  getDb()
    .prepare(
      `INSERT INTO directory_tree 
       (agent_id, path, file_name, is_directory, parent_path, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, path) DO NOTHING`,
    )
    .run(agentId, normalized, fileName, isDirectory ? 1 : 0, parentPath, now());
}

/**
 * Get all entries in a directory (one level deep).
 */
function getDirectoryContents(agentId, dirPath) {
  return getDb()
    .prepare(
      `SELECT path, file_name, is_directory, discovered_at
       FROM directory_tree
       WHERE agent_id = ? AND parent_path = ?
       ORDER BY is_directory DESC, file_name ASC`,
    )
    .all(agentId, dirPath);
}

/**
 * Get the complete directory tree as JSON (hierarchical).
 * Used for display in VS Code sidebar and for searching.
 */
function getDirectoryTreeAsJson(agentId) {
  const entries = getDb()
    .prepare(
      `SELECT path, file_name, is_directory, parent_path
       FROM directory_tree
       WHERE agent_id = ?
       ORDER BY path ASC`,
    )
    .all(agentId);

  const fileLocations = getDb()
    .prepare(
      `SELECT id, discovered_path
       FROM file_locations
       WHERE agent_id = ? AND exists_flag = 1
       ORDER BY id DESC`,
    )
    .all(agentId);

  const fileContentLocationIds = new Set(
    getDb()
      .prepare(
        `SELECT DISTINCT file_location_id
         FROM file_contents`,
      )
      .all()
      .map((r) => r.file_location_id),
  );

  const fileMetaByPath = new Map();
  for (const fl of fileLocations) {
    const p = String(fl.discovered_path || "").replace(/\//g, "\\");
    if (!fileMetaByPath.has(p)) {
      fileMetaByPath.set(p, {
        file_location_id: fl.id,
        has_cached_content: fileContentLocationIds.has(fl.id),
      });
    }
  }

  // Build hierarchy
  const root = {
    name: "C:",
    type: "directory",
    children: [],
    path: "C:",
  };
  const map = new Map();
  map.set("C:", root);

  function normalizePath(winPath) {
    return String(winPath || "").replace(/\//g, "\\");
  }

  function computeParent(winPath) {
    const normalized = String(winPath || "").replace(/\//g, "\\");
    const parts = normalized.split("\\").filter(Boolean);
    if (parts.length <= 1) return "C:";
    return parts.slice(0, -1).join("\\");
  }

  function nodeNameFromPath(winPath) {
    const parts = normalizePath(winPath).split("\\").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : winPath;
  }

  function addChild(parent, child) {
    if (!parent.children) parent.children = [];
    if (!parent.children.some((c) => c.path === child.path)) {
      parent.children.push(child);
    }
  }

  function ensureDirectoryNode(dirPath) {
    const normalizedDir = normalizePath(dirPath);
    if (map.has(normalizedDir)) return map.get(normalizedDir);
    if (normalizedDir === "C:") return root;

    const parentPath = computeParent(normalizedDir);
    const parent = ensureDirectoryNode(parentPath);

    const dirNode = {
      name: nodeNameFromPath(normalizedDir),
      type: "directory",
      path: normalizedDir,
      children: [],
      synthetic: true,
    };
    map.set(normalizedDir, dirNode);
    addChild(parent, dirNode);
    return dirNode;
  }

  for (const entry of entries) {
    const normalizedPath = normalizePath(entry.path || "");
    const parentPath = computeParent(normalizedPath);

    if (entry.is_directory) {
      const dirNode = ensureDirectoryNode(normalizedPath);
      dirNode.synthetic = false;
      dirNode.name = nodeNameFromPath(normalizedPath);
      continue;
    }

    const parent = ensureDirectoryNode(parentPath);
    const meta = fileMetaByPath.get(normalizedPath) || null;
    const fileNode = {
      name: nodeNameFromPath(normalizedPath),
      type: "file",
      path: normalizedPath,
      file_location_id: meta ? meta.file_location_id : null,
      has_cached_content: meta ? meta.has_cached_content : false,
    };
    map.set(normalizedPath, fileNode);
    addChild(parent, fileNode);
  }

  return root;
}

/**
 * Get all known files discovered on an agent (for context injection).
 * Returns most recently verified files that exist.
 */
function getKnownFilesForContextInjection(agentId, limit = 10) {
  return getDb()
    .prepare(
      `SELECT DISTINCT file_name, discovered_path, last_verified, is_text_file
       FROM file_locations
       WHERE agent_id = ? AND exists_flag = 1 AND is_text_file = 1
       ORDER BY last_verified DESC
       LIMIT ?`,
    )
    .all(agentId, limit);
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
  getKnownFileLocations,
  recordFileLocation,
  getFileLocationByPath,
  updateFileLocationVerification,
  markFileLocationsNotFound,
  storeFileContent,
  getFileContentRanges,
  getCachedFileContent,
  getFirstBytesOfFile,
  updateFileMetadata,
  recordDirectoryTreeEntry,
  getDirectoryContents,
  getDirectoryTreeAsJson,
  getKnownFilesForContextInjection,
};
