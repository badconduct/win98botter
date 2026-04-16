"use strict";

/**
 * GET /sse
 *
 * Server-Sent Events stream. Sends the full agent response as a single event
 * when complete. Future: token-by-token streaming.
 *
 * Query: ?session_id=s-1&message=...
 */
async function sseRoutes(fastify, opts) {
  const { llm, staging, registry, tokenBudget, phase1Store } = opts;
  const AgentLoop = require("../agent/loop");
  const queries = require("../db/queries");

  fastify.get(
    "/sse",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["session_id", "message"],
          properties: {
            session_id: { type: "string", minLength: 1, maxLength: 128 },
            message: { type: "string", minLength: 1, maxLength: 32768 },
            agent_id: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { session_id, message, agent_id } = request.query;
      let selectedAgentId = agent_id;

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.flushHeaders();

      const send = (event, data) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const entry = agent_id ? registry.get(agent_id) : registry.getDefault();
      if (!entry) {
        send("error", { message: "No Win98 agent connected" });
        reply.raw.end();
        return;
      }
      if (!selectedAgentId && entry.agentId) {
        selectedAgentId = entry.agentId;
      }
      const { connection, permissions, staging } = entry;

      if (!selectedAgentId) {
        selectedAgentId = connection.agentId;
      }

      queries.createSession(
        session_id,
        selectedAgentId,
        connection.remoteAddress,
        llm.model,
      );
      const loop = new AgentLoop(
        llm,
        connection,
        staging,
        permissions,
        fastify.log,
        {
          promptFlags: entry.promptFlags || null,
          phase1Store,
          selectedAgentId,
        },
      );

      try {
        send("start", { session_id });
        const result = await loop.run(session_id, message, tokenBudget);
        send("message", result);
        send("done", { session_id });
      } catch (err) {
        send("error", { message: err.message });
      }

      reply.raw.end();
    },
  );
}

module.exports = sseRoutes;
