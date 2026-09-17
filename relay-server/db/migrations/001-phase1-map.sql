-- Initial map schema for a fresh database. Apply once as the application
-- owner via the reviewed migrator role, NEVER as the runtime account.
-- Deployment supplies SET ROLE <app>_owner inside this transaction.
-- Forward-only: a fresh failed deployment can recreate its empty database;
-- do not drop tables to roll back an application after new data is written.
CREATE TABLE phase1_dir_entries (
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
CREATE INDEX idx_phase1_dir_entries_agent_dir
    ON phase1_dir_entries (agent_id, dir_path, observed_at DESC);

CREATE TABLE phase1_file_reads (
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
CREATE INDEX idx_phase1_file_reads_agent_file
    ON phase1_file_reads (agent_id, file_path, observed_at DESC);

CREATE TABLE phase1_registry_entries (
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
CREATE INDEX idx_phase1_registry_entries_agent_key
    ON phase1_registry_entries (agent_id, key_path, observed_at DESC);
