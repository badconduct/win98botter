"use strict";

const queries = require("../db/queries");

/**
 * POST /undo
 * Body: { change_id: N }
 *
 * Reverts a specific file change by writing the previous_value back via Win98.
 */
async function undoRoutes(fastify, opts) {
  const { registry } = opts;

  fastify.post(
    "/undo",
    {
      schema: {
        body: {
          type: "object",
          required: ["change_id"],
          properties: {
            change_id: { type: "integer", minimum: 1 },
            agent_id: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { change_id, agent_id } = request.body;
      const change = queries.getFileChangeById(change_id);

      if (!change) {
        return reply.status(404).send({ error: "Change not found" });
      }

      const entry = agent_id ? registry.get(agent_id) : registry.getDefault();
      const win98 = entry ? entry.connection : null;

      if (!win98 || !win98.connected) {
        return reply
          .status(503)
          .send({ error: "Win98 agent not connected — cannot undo" });
      }

      if (change.action === "write") {
        if (!change.previous_value && !change.backup_path) {
          return reply.status(400).send({
            error: "No previous value stored for this change — cannot undo",
          });
        }

        if (change.backup_path) {
          // Restore from backup via Win98 tool
          try {
            const ts = change.backup_path.split("\\").pop().replace(".bak", "");
            await win98.callTool("restore_backup", {
              path: change.win98_path,
              timestamp: ts,
            });
            return reply.send({
              success: true,
              restored_from: change.backup_path,
            });
          } catch (err) {
            return reply.status(500).send({ error: err.message });
          }
        } else {
          // Write previous value directly
          try {
            await win98.callTool("write_file", {
              path: change.win98_path,
              content: change.previous_value,
            });
            return reply.send({
              success: true,
              note: "Restored previous content",
            });
          } catch (err) {
            return reply.status(500).send({ error: err.message });
          }
        }
      }

      if (change.action === "registry_write") {
        return reply.status(400).send({
          error:
            "Registry undo not implemented — use read_registry and write_registry via /chat",
        });
      }

      return reply
        .status(400)
        .send({ error: `Undo not supported for action: ${change.action}` });
    },
  );
}

module.exports = undoRoutes;
