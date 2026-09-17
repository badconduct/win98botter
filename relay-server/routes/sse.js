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
  const { llm, registry, tokenBudget, phase1Store, state } = opts;
  const AgentLoop = require("../agent/loop");
  const AgentRunQueue = require("../agent/run-queue");
  const queries = require("../db/queries");
  const runQueue = opts.runQueue || new AgentRunQueue();

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

      if (state && state.paused) {
        send("error", {
          message: "Agent execution is paused by the central controller",
        });
        reply.raw.end();
        return;
      }

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
        "administrator",
      );

      try {
        send("start", { session_id });
        const queueAgentId = entry.canonicalAgentId || selectedAgentId;
        const result = await runQueue.run(queueAgentId, async () => {
          if (state && state.paused) {
            const err = new Error(
              "Agent execution was paused while this request was queued",
            );
            err.statusCode = 423;
            throw err;
          }
          if (!connection.connected) {
            const err = new Error("Win98 agent disconnected while queued");
            err.statusCode = 503;
            throw err;
          }

          const loop = new AgentLoop(
            llm,
            connection,
            staging,
            permissions,
            fastify.log,
            {
              promptFlags: entry.promptFlags || null,
              customPrompt: entry.customPrompt || "",
              phase1Store,
              selectedAgentId,
            },
          );
          return loop.run(session_id, message, tokenBudget);
        });
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
