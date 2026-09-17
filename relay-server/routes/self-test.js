"use strict";

const { runAgentSelfTest } = require("../agent/self-test");

async function selfTestRoutes(fastify, opts) {
  const { registry, runQueue } = opts;

  fastify.post(
    "/api/agents/:agentId/self-test",
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
      if (!entry) return reply.code(404).send({ error: "Agent not found" });
      if (!entry.connection.connected) {
        return reply.code(503).send({ error: "Win98 agent is not connected" });
      }

      const queueId = entry.canonicalAgentId || agentId;
      try {
        const report = await runQueue.run(queueId, () =>
          runAgentSelfTest(entry, fastify.log),
        );
        return reply.send(report);
      } catch (error) {
        fastify.log.warn(
          { agentId, error: error.message },
          "Deterministic agent self-test failed",
        );
        return reply.code(500).send({ error: error.message });
      }
    },
  );
}

module.exports = selfTestRoutes;
