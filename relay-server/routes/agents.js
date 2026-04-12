"use strict";

/**
 * GET  /api/agents          — list all known agents (connected + recently seen from DB)
 * GET  /api/agents/:agentId — single agent detail
 */

const queries = require("../db/queries");

async function agentsRoutes(fastify, opts) {
  const { registry } = opts;

  // ── GET /api/agents ────────────────────────────────────────────────────────
  fastify.get("/api/agents", async (_req, reply) => {
    const liveAgents = registry.list();
    const liveIds = new Set(liveAgents.map((a) => a.agentId));

    // Merge DB records for agents that have connected before but are now offline
    const dbAgents = queries.listAgents();
    const offline = dbAgents
      .filter((a) => !liveIds.has(a.agent_id))
      .map((a) => ({
        agentId: a.agent_id,
        hostname: a.hostname,
        host: a.ip_address,
        connected: false,
        online: false,
        lastHeartbeat: null,
        lastSeen: a.last_seen,
        agentInfo: null,
      }));

    return reply.send([...liveAgents, ...offline]);
  });

  // ── GET /api/agents/:agentId ───────────────────────────────────────────────
  fastify.get(
    "/api/agents/:agentId",
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
      const conn = registry.getConnection(agentId);
      if (conn) return reply.send(conn.getStatus());

      const row = queries.getAgent(agentId);
      if (!row) return reply.code(404).send({ error: "Agent not found" });

      return reply.send({
        agentId: row.agent_id,
        hostname: row.hostname,
        host: row.ip_address,
        connected: false,
        lastSeen: row.last_seen,
      });
    },
  );

  // ── DELETE /api/agents/:agentId ────────────────────────────────────────────
  fastify.delete(
    "/api/agents/:agentId",
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
      const entry = registry.get(agentId);

      if (entry) {
        try {
          if (entry.watchdog) entry.watchdog.stop();
          entry.connection.disconnect();
        } finally {
          registry.remove(agentId);
        }
      }

      queries.deleteAgent(agentId);
      return reply.send({ success: true, agentId });
    },
  );
}

module.exports = agentsRoutes;
