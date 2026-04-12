"use strict";

function normalizeWinPath(input) {
  if (!input) return input;
  const str = String(input);
  if (str.startsWith("\\\\")) {
    const rest = str.slice(2).replace(/\\{2,}/g, "\\");
    return "\\\\" + rest;
  }
  return str.replace(/\\{2,}/g, "\\");
}

async function mapCacheRoutes(fastify, opts) {
  const { phase1Store } = opts;

  // ── POST /api/map/files/dir-scan ──────────────────────────────────────────
  fastify.post(
    "/api/map/files/dir-scan",
    {
      schema: {
        body: {
          type: "object",
          required: ["agent_id", "dir_path", "entries"],
          properties: {
            agent_id: { type: "string" },
            dir_path: { type: "string" },
            scan_duration_ms: { type: "integer" },
            source_tool: { type: "string" },
            entries: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "entry_type"],
                properties: {
                  name: { type: "string" },
                  entry_type: { type: "string" },
                  size_bytes: { type: "integer" },
                  modified_at: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!phase1Store.enabled) {
        return reply.code(503).send({
          error: "Phase 1 cache is disabled",
          hint: "Enable PHASE1_PG_ENABLED and PostgreSQL settings.",
        });
      }

      const result = await phase1Store.upsertDirScan({
        agentId: request.body.agent_id,
        dirPath: normalizeWinPath(request.body.dir_path),
        entries: request.body.entries,
        scanDurationMs: request.body.scan_duration_ms,
        sourceTool: request.body.source_tool,
      });

      return reply.send({ success: true, ...result });
    },
  );

  // ── GET /api/map/files ─────────────────────────────────────────────────────
  fastify.get(
    "/api/map/files",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["agent_id", "dir_path"],
          properties: {
            agent_id: { type: "string" },
            dir_path: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      if (!phase1Store.enabled) {
        return reply.code(503).send({
          error: "Phase 1 cache is disabled",
          hint: "Enable PHASE1_PG_ENABLED and PostgreSQL settings.",
        });
      }

      const entries = await phase1Store.listDirEntries({
        agentId: request.query.agent_id,
        dirPath: normalizeWinPath(request.query.dir_path),
      });

      return reply.send({ entries });
    },
  );

  // ── POST /api/map/files/read-capture ──────────────────────────────────────
  fastify.post(
    "/api/map/files/read-capture",
    {
      schema: {
        body: {
          type: "object",
          required: ["agent_id", "file_path"],
          properties: {
            agent_id: { type: "string" },
            file_path: { type: "string" },
            line_start: { type: "integer" },
            line_end: { type: "integer" },
            byte_start: { type: "integer" },
            byte_end: { type: "integer" },
            is_partial: { type: "boolean" },
            content: { type: "string" },
            content_hash: { type: "string" },
            source_tool: { type: "string" },
            session_id: { type: "string" },
            duration_ms: { type: "integer" },
          },
        },
      },
    },
    async (request, reply) => {
      if (!phase1Store.enabled) {
        return reply.code(503).send({
          error: "Phase 1 cache is disabled",
          hint: "Enable PHASE1_PG_ENABLED and PostgreSQL settings.",
        });
      }

      await phase1Store.saveFileReadCapture({
        agentId: request.body.agent_id,
        filePath: normalizeWinPath(request.body.file_path),
        line_start: request.body.line_start,
        line_end: request.body.line_end,
        byte_start: request.body.byte_start,
        byte_end: request.body.byte_end,
        is_partial: request.body.is_partial,
        content: request.body.content,
        content_hash: request.body.content_hash,
        source_tool: request.body.source_tool,
        session_id: request.body.session_id,
        duration_ms: request.body.duration_ms,
      });

      return reply.send({ success: true });
    },
  );

  // ── GET /api/map/files/read-capture ───────────────────────────────────────
  fastify.get(
    "/api/map/files/read-capture",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["agent_id", "file_path"],
          properties: {
            agent_id: { type: "string" },
            file_path: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!phase1Store.enabled) {
        return reply.code(503).send({
          error: "Phase 1 cache is disabled",
          hint: "Enable PHASE1_PG_ENABLED and PostgreSQL settings.",
        });
      }

      const captures = await phase1Store.listFileReadCaptures({
        agentId: request.query.agent_id,
        filePath: normalizeWinPath(request.query.file_path),
        limit: request.query.limit,
      });

      return reply.send({ captures });
    },
  );

  // ── POST /api/map/registry/capture ────────────────────────────────────────
  fastify.post(
    "/api/map/registry/capture",
    {
      schema: {
        body: {
          type: "object",
          required: ["agent_id", "key_path", "values"],
          properties: {
            agent_id: { type: "string" },
            key_path: { type: "string" },
            source_tool: { type: "string" },
            values: {
              type: "array",
              items: {
                type: "object",
                required: ["value_name"],
                properties: {
                  value_name: { type: "string" },
                  value_type: { type: "string" },
                  value_data: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!phase1Store.enabled) {
        return reply.code(503).send({
          error: "Phase 1 cache is disabled",
          hint: "Enable PHASE1_PG_ENABLED and PostgreSQL settings.",
        });
      }

      const result = await phase1Store.upsertRegistryCapture({
        agentId: request.body.agent_id,
        keyPath: normalizeWinPath(request.body.key_path),
        values: request.body.values,
        sourceTool: request.body.source_tool,
      });

      return reply.send({ success: true, ...result });
    },
  );

  // ── GET /api/map/registry ──────────────────────────────────────────────────
  fastify.get(
    "/api/map/registry",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["agent_id", "key_path"],
          properties: {
            agent_id: { type: "string" },
            key_path: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      if (!phase1Store.enabled) {
        return reply.code(503).send({
          error: "Phase 1 cache is disabled",
          hint: "Enable PHASE1_PG_ENABLED and PostgreSQL settings.",
        });
      }

      const values = await phase1Store.listRegistryEntries({
        agentId: request.query.agent_id,
        keyPath: normalizeWinPath(request.query.key_path),
      });

      return reply.send({ values });
    },
  );
}

module.exports = mapCacheRoutes;
