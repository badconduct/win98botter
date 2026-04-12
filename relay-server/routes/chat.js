"use strict";

const queries = require("../db/queries");
const AgentLoop = require("../agent/loop");

/**
 * POST /chat
 * Body: { message, agent_id, [session_id] }
 * session_id is optional — if omitted, the latest session for the agent is
 * reused, or a new one is created automatically.
 * Response: { response, tool_calls_made, llm_calls_made, tokens_used }
 */
async function chatRoutes(fastify, opts) {
  const { llm, staging, registry, tokenBudget } = opts;

  fastify.post(
    "/chat",
    {
      schema: {
        body: {
          type: "object",
          required: ["message"],
          properties: {
            session_id: { type: "string", minLength: 1, maxLength: 128 },
            message: { type: "string", minLength: 1, maxLength: 32768 },
            agent_id: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      let { session_id, message, agent_id } = request.body;

      const entry = agent_id ? registry.get(agent_id) : registry.getDefault();
      if (!entry) {
        return reply.status(503).send({ error: "No Win98 agent connected" });
      }
      const { connection, permissions } = entry;

      // Auto-resolve session_id: reuse the latest session for this agent or generate a new one
      if (!session_id) {
        const existing = queries.getLatestSessionByAgentId(connection.agentId);
        session_id = existing
          ? existing.id
          : `sess-${connection.agentId}-${Date.now()}`;
      }

      queries.createSession(
        session_id,
        connection.agentId,
        connection.remoteAddress,
        llm.model,
      );

      const loop = new AgentLoop(
        llm,
        connection,
        staging,
        permissions,
        fastify.log,
      );
      const result = await loop.run(session_id, message, tokenBudget);

      return reply.send({ session_id, ...result });
    },
  );
}

module.exports = chatRoutes;
