"use strict";

/**
 * File Activity Routes
 *
 * GET  /api/file-activity/tree/:agentId         - directory tree (hierarchical JSON)
 * GET  /api/file-activity/content/:agentId/:fid - cached file content
 * GET  /api/file-activity/search                - search files by name
 */

const queries = require("../db/queries");
const { getDb } = require("../db/schema");

async function fileActivityRoutes(fastify, opts) {
  // ── GET /api/file-activity/tree/:agentId ──────────────────────────────────
  fastify.get(
    "/api/file-activity/tree/:agentId",
    {
      schema: {
        params: {
          type: "object",
          properties: { agentId: { type: "string" } },
          required: ["agentId"],
        },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;

      try {
        const tree = queries.getDirectoryTreeAsJson(agentId);
        return reply.send(
          tree || { name: "C:", type: "directory", children: [] },
        );
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: err.message });
      }
    },
  );

  // ── GET /api/file-activity/content/:agentId/:fileLocationId ────────────────
  fastify.get(
    "/api/file-activity/content/:agentId/:fileLocationId",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            fileLocationId: { type: "string" },
          },
          required: ["agentId", "fileLocationId"],
        },
      },
    },
    async (request, reply) => {
      const { agentId, fileLocationId } = request.params;

      try {
        const db = getDb();

        // Get file location record
        const fileLocation = db
          .prepare(
            `SELECT id, file_name, discovered_path, mime_type, is_text_file, file_size_bytes 
           FROM file_locations 
           WHERE agent_id = ? AND id = ?`,
          )
          .get(agentId, fileLocationId);

        if (!fileLocation) {
          return reply.code(404).send({ error: "File location not found" });
        }

        // Get cached file content
        const contentRow = db
          .prepare(
            `SELECT content, updated_at, bytes_read
           FROM file_contents
           WHERE file_location_id = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
          )
          .get(fileLocation.id);

        if (!contentRow) {
          return reply.send({
            file_location_id: fileLocation.id,
            path: fileLocation.discovered_path,
            file_name: fileLocation.file_name,
            content: null,
            mime_type: fileLocation.mime_type,
            exists: fileLocation.file_size_bytes !== null,
            updated_at: null,
          });
        }

        return reply.send({
          file_location_id: fileLocation.id,
          path: fileLocation.discovered_path,
          file_name: fileLocation.file_name,
          content: contentRow.content,
          mime_type: fileLocation.mime_type || "application/octet-stream",
          exists: true,
          updated_at: contentRow.updated_at,
          bytes_read: contentRow.bytes_read,
        });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: err.message });
      }
    },
  );

  // ── GET /api/file-activity/search ──────────────────────────────────────────
  fastify.get(
    "/api/file-activity/search",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            q: { type: "string" },
          },
          required: ["agentId", "q"],
        },
      },
    },
    async (request, reply) => {
      const { agentId, q } = request.query;

      if (!agentId || !q) {
        return reply
          .code(400)
          .send({ error: "Missing agentId or q parameter" });
      }

      try {
        const db = getDb();

        // Search by file name
        const results = db
          .prepare(
            `SELECT DISTINCT id, file_name, discovered_path, is_text_file, mime_type 
           FROM file_locations
           WHERE agent_id = ? AND file_name LIKE ?
           ORDER BY file_name ASC
           LIMIT 20`,
          )
          .all(agentId, `%${q}%`);

        return reply.send({
          query: q,
          results: results.map((r) => ({
            id: r.id,
            file_name: r.file_name,
            path: r.discovered_path,
            is_text: r.is_text_file ? true : false,
            mime_type: r.mime_type,
          })),
        });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: err.message });
      }
    },
  );
}

module.exports = fileActivityRoutes;
