"use strict";

const Database = require("better-sqlite3");

let db = null;

function initDb(dbPath) {
  if (dbPath) {
    db = new Database(dbPath);
  } else {
    db = new Database(":memory:");
  }

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id   TEXT PRIMARY KEY,
      hostname   TEXT,
      ip_address TEXT,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT,
      started_at  TEXT NOT NULL,
      win98_host  TEXT,
      llm_model   TEXT,
      token_total INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      tool_name   TEXT NOT NULL,
      args_json   TEXT NOT NULL,
      result_json TEXT,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS file_changes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      action         TEXT NOT NULL,
      win98_path     TEXT NOT NULL,
      backup_path    TEXT,
      previous_value TEXT,
      new_value      TEXT
    );

    CREATE TABLE IF NOT EXISTS file_locations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        TEXT NOT NULL,
      file_name       TEXT NOT NULL,
      discovered_path TEXT NOT NULL,
      first_found_at  TEXT NOT NULL,
      last_verified   TEXT NOT NULL,
      exists_flag     INTEGER DEFAULT 1,
      mime_type       TEXT,
      is_text_file    INTEGER DEFAULT 0,
      file_size_bytes INTEGER,
      UNIQUE(agent_id, file_name, discovered_path)
    );

    CREATE INDEX IF NOT EXISTS idx_file_locations_lookup 
      ON file_locations(agent_id, file_name);

    CREATE INDEX IF NOT EXISTS idx_file_locations_text
      ON file_locations(agent_id, is_text_file) WHERE is_text_file = 1;

    CREATE TABLE IF NOT EXISTS file_contents (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      file_location_id  INTEGER NOT NULL,
      line_start        INTEGER,
      line_end          INTEGER,
      content           TEXT NOT NULL,
      content_hash      TEXT,
      bytes_read        INTEGER,
      updated_at        TEXT NOT NULL,
      FOREIGN KEY(file_location_id) REFERENCES file_locations(id),
      UNIQUE(file_location_id, line_start, line_end)
    );

    CREATE INDEX IF NOT EXISTS idx_file_contents_location
      ON file_contents(file_location_id, line_start);

    CREATE TABLE IF NOT EXISTS directory_tree (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT NOT NULL,
      path         TEXT NOT NULL,
      file_name    TEXT NOT NULL,
      is_directory INTEGER DEFAULT 0,
      parent_path  TEXT,
      discovered_at TEXT NOT NULL,
      UNIQUE(agent_id, path)
    );

    CREATE INDEX IF NOT EXISTS idx_directory_tree_lookup
      ON directory_tree(agent_id, parent_path);

    CREATE INDEX IF NOT EXISTS idx_directory_tree_file
      ON directory_tree(agent_id, is_directory);
  `);

  // Compatibility migration: older builds used "exists" as the file state column.
  // Ensure the current "exists_flag" column is present and populated.
  const cols = db.prepare("PRAGMA table_info(file_locations)").all();
  const hasExistsFlag = cols.some((c) => c.name === "exists_flag");
  const hasLegacyExists = cols.some((c) => c.name === "exists");

  if (!hasExistsFlag) {
    db.exec(
      "ALTER TABLE file_locations ADD COLUMN exists_flag INTEGER DEFAULT 1",
    );
  }
  if (hasLegacyExists) {
    db.exec(
      'UPDATE file_locations SET exists_flag = COALESCE(exists_flag, "exists", 1)',
    );
  }

  return db;
}

function getDb() {
  if (!db) throw new Error("Database not initialised — call initDb() first");
  return db;
}

module.exports = { initDb, getDb };
