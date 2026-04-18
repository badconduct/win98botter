"use strict";

const queries = require("../db/queries");
const AgentLoop = require("../agent/loop");

/**
 * POST /chat
 * Body: { message, agent_id, [session_id], [source] }
 * session_id is optional — if omitted, the latest session for the agent/source
 * is reused, or a new one is created automatically.
 * Response: { response, tool_calls_made, llm_calls_made, tokens_used }
 */
function normalizeSource(source) {
  const value = String(source || "administrator")
    .trim()
    .toLowerCase();
  if (value === "admin") return "administrator";
  if (value === "vb6") return "user";
  return value || "administrator";
}

async function chatRoutes(fastify, opts) {
  const { llm, staging, registry, tokenBudget, phase1Store } = opts;

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
            source: { type: "string", minLength: 1, maxLength: 32 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        let { session_id, message, agent_id, source } = request.body;
        const chatSource = normalizeSource(source);
        let selectedAgentId = agent_id;

        const entry = agent_id ? registry.get(agent_id) : registry.getDefault();
        if (!entry) {
          return reply.status(503).send({ error: "No Win98 agent connected" });
        }
        if (!selectedAgentId && entry.agentId) {
          selectedAgentId = entry.agentId;
        }
        const { connection, permissions, staging } = entry;

        if (!selectedAgentId) {
          selectedAgentId = connection.agentId;
        }

        // Auto-resolve session_id: reuse the latest session for this agent/source or generate a new one
        if (!session_id) {
          const existing = queries.getLatestSessionByAgentId(
            selectedAgentId,
            chatSource,
          );
          session_id = existing
            ? existing.id
            : `sess-${chatSource}-${selectedAgentId}-${Date.now()}`;
        }

        queries.createSession(
          session_id,
          selectedAgentId,
          connection.remoteAddress,
          llm.model,
          chatSource,
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
        const result = await loop.run(session_id, message, tokenBudget);

        return reply.send({ session_id, source: chatSource, ...result });
      } catch (err) {
        fastify.log.error({ err }, "Chat request failed");
        return reply.status(500).send({
          error: err && err.message ? err.message : "Chat request failed",
        });
      }
    },
  );
}

module.exports = chatRoutes;
