"use strict";

/**
 * POST /control
 * Body: { action: "pause" | "resume" | "disconnect" | "permissions" | "reload_permissions" }
 *
 * pause/resume  — halt/resume agent loop processing
 * disconnect    — close the active Win98 TCP connection
 * permissions   — update the permission set; body includes permissions object
 */
async function controlRoutes(fastify, opts) {
  const { registry, state } = opts;

  fastify.post(
    "/control",
    {
      schema: {
        body: {
          type: "object",
          required: ["action"],
          properties: {
            action: {
              type: "string",
              enum: [
                "pause",
                "resume",
                "disconnect",
                "permissions",
                "reload_permissions",
              ],
            },
            agent_id: { type: "string" },
            permissions: { type: "object" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { action, agent_id, permissions: newPerms } = request.body;

      const entry = agent_id ? registry.get(agent_id) : registry.getDefault();
      const win98 = entry ? entry.connection : null;
      const permissions = entry ? entry.permissions : null;

      switch (action) {
        case "pause":
          state.paused = true;
          return reply.send({ success: true, state: "paused" });

        case "resume":
          state.paused = false;
          return reply.send({ success: true, state: "running" });

        case "disconnect":
          if (!win98)
            return reply.status(503).send({ error: "No agent connected" });
          win98.disconnect();
          return reply.send({ success: true, note: "Win98 socket closed" });

        case "permissions":
          if (!newPerms || typeof newPerms !== "object") {
            return reply
              .status(400)
              .send({ error: "permissions object required" });
          }
          if (!permissions)
            return reply.status(503).send({ error: "No agent connected" });
          permissions.update(newPerms);
          /* Push the updated permission state to the Win98 agent so it
           * takes effect immediately without requiring a restart or manual
           * edit of permissions.ini on the Win98 machine.
           * Use getAsToolLevel() to send in agent-compatible format. */
          if (win98 && win98.connected) {
            try {
              await win98.call("set_permissions", permissions.getAsToolLevel());
              const listed = await win98.listTools();
              if (win98.agentInfo) {
                win98.agentInfo.permissions = permissions.getAsToolLevel();
                win98.agentInfo.tools = listed?.tools || [];
              }
            } catch (pushErr) {
              fastify.log.warn(
                { err: pushErr },
                "set_permissions push or capability refresh failed",
              );
            }
          }
          return reply.send({
            success: true,
            permissions: permissions.getAll(),
          });

        case "reload_permissions":
          if (!win98 || !permissions) {
            return reply.status(503).send({ error: "No agent connected" });
          }
          try {
            const loaded = await win98.call("permissions/update", {});
            permissions.update(loaded || {});
            const listed = await win98.listTools();
            if (win98.agentInfo) {
              win98.agentInfo.permissions = loaded || {};
              win98.agentInfo.tools = listed?.tools || [];
            }
            return reply.send({
              success: true,
              source: "Win98 permissions.ini",
              permissions: permissions.getAll(),
            });
          } catch (err) {
            return reply.status(500).send({ error: err.message });
          }

        default:
          return reply.status(400).send({ error: "Unknown action" });
      }
    },
  );
}

module.exports = controlRoutes;
