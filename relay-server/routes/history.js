"use strict";

const queries = require("../db/queries");

/**
 * GET /history?agent_id=XXX[&session_id=s-1][&source=user|administrator][&limit=50]
 *
 * Either agent_id or session_id must be provided.
 * If only agent_id is given, uses the most recent session for that agent/source.
 */
async function historyRoutes(fastify, opts) {
  fastify.get(
    "/history",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            session_id: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
            source: { type: "string", minLength: 1, maxLength: 32 },
          },
        },
      },
    },
    async (request, reply) => {
      let { agent_id, session_id, limit, source } = request.query;
      const normalizedSource = source
        ? String(source).trim().toLowerCase()
        : "";

      if (!session_id && agent_id) {
        const sess = queries.getLatestSessionByAgentId(
          agent_id,
          normalizedSource,
        );
        session_id = sess ? sess.id : null;
      }

      if (!session_id) {
        return reply.send({ session: null, messages: [], tool_calls: [] });
      }

      const messages = queries.getRecentMessages(session_id, limit);
      const toolCalls = queries.getToolCalls(session_id, limit);
      const session = queries.getSession(session_id);
      return reply.send({ session, messages, tool_calls: toolCalls });
    },
  );
}

module.exports = historyRoutes;
