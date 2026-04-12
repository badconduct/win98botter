"use strict";

/**
 * GET /health
 * Returns relay status, Win98 connection state, LLM reachability, uptime.
 */

const START_TIME = Date.now();

async function healthRoutes(fastify, opts) {
  const { registry, llm } = opts;

  fastify.get("/health", async (request, reply) => {
    const def = registry.getDefault();
    const conn = def ? def.connection : null;
    const uptimeSec = Math.floor((Date.now() - START_TIME) / 1000);

    return reply.send({
      relay: true,
      agent_id: conn ? conn.agentId : null,
      win98_connected: conn ? conn.connected : false,
      win98_host: conn ? conn.remoteAddress : null,
      win98_info: conn ? conn.agentInfo : null,
      last_heartbeat:
        conn && conn.lastHeartbeat
          ? new Date(conn.lastHeartbeat).toISOString()
          : null,
      llm_model: llm.model,
      uptime_seconds: uptimeSec,
    });
  });
}

module.exports = healthRoutes;
