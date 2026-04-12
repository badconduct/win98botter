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
  `);

  return db;
}

function getDb() {
  if (!db) throw new Error("Database not initialised — call initDb() first");
  return db;
}

module.exports = { initDb, getDb };
