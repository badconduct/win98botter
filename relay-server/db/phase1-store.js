"use strict";

const { Pool } = require("pg");

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const v = String(value).toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function createPhase1Store(config, logger) {
  const enabled = parseBool(config.phase1PgEnabled, false);
  if (!enabled) {
    return {
      enabled: false,
      async init() {},
      async close() {},
      async upsertDirScan() {
        return { disabled: true };
      },
      async listDirEntries() {
        return [];
      },
      async saveFileReadCapture() {
        return { disabled: true };
      },
      async listFileReadCaptures() {
        return [];
      },
      async upsertRegistryCapture() {
        return { disabled: true };
      },
      async listRegistryEntries() {
        return [];
      },
    };
  }

  const pool = new Pool({
    connectionString: config.phase1PgUrl || undefined,
    host: config.phase1PgHost || undefined,
    port: config.phase1PgPort ? Number(config.phase1PgPort) : undefined,
    database: config.phase1PgDatabase || undefined,
    user: config.phase1PgUser || undefined,
    password: config.phase1PgPassword || undefined,
    ssl: parseBool(config.phase1PgSsl, false)
      ? { rejectUnauthorized: false }
      : false,
  });

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS phase1_dir_entries (
        id BIGSERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        dir_path TEXT NOT NULL,
        name TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        size_bytes BIGINT,
        modified_at TIMESTAMPTZ,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scan_duration_ms INTEGER,
        source_tool TEXT,
        UNIQUE (agent_id, dir_path, name)
      );

      CREATE INDEX IF NOT EXISTS idx_phase1_dir_entries_agent_dir
        ON phase1_dir_entries (agent_id, dir_path, observed_at DESC);

      CREATE TABLE IF NOT EXISTS phase1_file_reads (
        id BIGSERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        line_end INTEGER,
        byte_start INTEGER,
        byte_end INTEGER,
        is_partial BOOLEAN NOT NULL DEFAULT TRUE,
        content TEXT,
        content_hash TEXT,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source_tool TEXT,
        session_id TEXT,
        duration_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_phase1_file_reads_agent_file
        ON phase1_file_reads (agent_id, file_path, observed_at DESC);

      CREATE TABLE IF NOT EXISTS phase1_registry_entries (
        id BIGSERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        key_path TEXT NOT NULL,
        value_name TEXT NOT NULL,
        value_type TEXT,
        value_data TEXT,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source_tool TEXT,
        UNIQUE (agent_id, key_path, value_name)
      );

      CREATE INDEX IF NOT EXISTS idx_phase1_registry_entries_agent_key
        ON phase1_registry_entries (agent_id, key_path, observed_at DESC);
    `);

    logger.info("Phase 1 PostgreSQL cache initialized");
  }

  async function close() {
    await pool.end();
  }

  async function upsertDirScan({
    agentId,
    dirPath,
    entries,
    scanDurationMs,
    sourceTool,
  }) {
    const client = await pool.connect();
    let upserted = 0;

    try {
      await client.query("BEGIN");

      for (const entry of entries || []) {
        await client.query(
          `
          INSERT INTO phase1_dir_entries (
            agent_id, dir_path, name, entry_type, size_bytes,
            modified_at, observed_at, scan_duration_ms, source_tool
          )
          VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8)
          ON CONFLICT (agent_id, dir_path, name)
          DO UPDATE SET
            entry_type = EXCLUDED.entry_type,
            size_bytes = EXCLUDED.size_bytes,
            modified_at = EXCLUDED.modified_at,
            observed_at = NOW(),
            scan_duration_ms = EXCLUDED.scan_duration_ms,
            source_tool = EXCLUDED.source_tool
          `,
          [
            agentId,
            dirPath,
            entry.name,
            entry.entry_type || "unknown",
            entry.size_bytes ?? null,
            entry.modified_at || null,
            scanDurationMs ?? null,
            sourceTool || null,
          ],
        );
        upserted += 1;
      }

      await client.query("COMMIT");
      return { upserted };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async function listDirEntries({ agentId, dirPath }) {
    const { rows } = await pool.query(
      `
      SELECT name, entry_type, size_bytes, modified_at, observed_at, scan_duration_ms, source_tool
      FROM phase1_dir_entries
      WHERE agent_id = $1 AND dir_path = $2
      ORDER BY entry_type, name
      `,
      [agentId, dirPath],
    );
    return rows;
  }

  async function saveFileReadCapture(payload) {
    const isPartial =
      payload.is_partial !== undefined
        ? !!payload.is_partial
        : payload.line_start !== null ||
          payload.line_end !== null ||
          payload.byte_start !== null ||
          payload.byte_end !== null;

    await pool.query(
      `
      INSERT INTO phase1_file_reads (
        agent_id, file_path, line_start, line_end, byte_start, byte_end,
        is_partial, content, content_hash, observed_at, source_tool,
        session_id, duration_ms
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11,$12)
      `,
      [
        payload.agentId,
        payload.filePath,
        payload.line_start ?? null,
        payload.line_end ?? null,
        payload.byte_start ?? null,
        payload.byte_end ?? null,
        isPartial,
        payload.content ?? null,
        payload.content_hash ?? null,
        payload.source_tool ?? null,
        payload.session_id ?? null,
        payload.duration_ms ?? null,
      ],
    );

    return { saved: true };
  }

  async function listFileReadCaptures({ agentId, filePath, limit }) {
    const { rows } = await pool.query(
      `
      SELECT line_start, line_end, byte_start, byte_end, is_partial,
             content_hash, observed_at, source_tool, session_id, duration_ms
      FROM phase1_file_reads
      WHERE agent_id = $1 AND file_path = $2
      ORDER BY observed_at DESC
      LIMIT $3
      `,
      [agentId, filePath, limit || 20],
    );
    return rows;
  }

  async function upsertRegistryCapture({
    agentId,
    keyPath,
    values,
    sourceTool,
  }) {
    const client = await pool.connect();
    let upserted = 0;

    try {
      await client.query("BEGIN");

      for (const value of values || []) {
        await client.query(
          `
          INSERT INTO phase1_registry_entries (
            agent_id, key_path, value_name, value_type, value_data, observed_at, source_tool
          )
          VALUES ($1,$2,$3,$4,$5,NOW(),$6)
          ON CONFLICT (agent_id, key_path, value_name)
          DO UPDATE SET
            value_type = EXCLUDED.value_type,
            value_data = EXCLUDED.value_data,
            observed_at = NOW(),
            source_tool = EXCLUDED.source_tool
          `,
          [
            agentId,
            keyPath,
            value.value_name,
            value.value_type ?? null,
            value.value_data ?? null,
            sourceTool || null,
          ],
        );
        upserted += 1;
      }

      await client.query("COMMIT");
      return { upserted };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async function listRegistryEntries({ agentId, keyPath }) {
    const { rows } = await pool.query(
      `
      SELECT value_name, value_type, value_data, observed_at, source_tool
      FROM phase1_registry_entries
      WHERE agent_id = $1 AND key_path = $2
      ORDER BY value_name
      `,
      [agentId, keyPath],
    );
    return rows;
  }

  return {
    enabled: true,
    init,
    close,
    upsertDirScan,
    listDirEntries,
    saveFileReadCapture,
    listFileReadCaptures,
    upsertRegistryCapture,
    listRegistryEntries,
  };
}

module.exports = { createPhase1Store };
