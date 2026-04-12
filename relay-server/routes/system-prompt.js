"use strict";

const { buildSystemPrompt } = require("../agent/context");
const { schemaList } = require("../win98/tools");
const PermissionsManager = require("../agent/permissions");

/**
 * GET /api/system-prompt?agent_id=XXX
 *
 * Returns the live system prompt that will be sent to the LLM for this agent.
 * Reads the agent's current permissions from the registry so the tool list
 * shown in the prompt is always accurate.
 */
async function systemPromptRoutes(fastify, opts) {
  const { registry } = opts;

  fastify.get(
    "/api/system-prompt",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { agent_id } = request.query;

      let permissions;
      if (agent_id) {
        const entry = registry.get(agent_id);
        permissions = entry ? entry.permissions : new PermissionsManager();
      } else {
        const def = registry.getDefault();
        permissions = def ? def.permissions : new PermissionsManager();
      }

      const allSchemas = schemaList();
      const allowedNames = permissions
        .filterSchemas(allSchemas)
        .map((s) => s.name);

      const entry = agent_id ? registry.get(agent_id) : registry.getDefault();
      const agentInfo = entry ? entry.connection.agentInfo : null;

      const prompt = buildSystemPrompt(allowedNames, permissions, agentInfo);
      return reply.send({ prompt });
    },
  );
}

module.exports = systemPromptRoutes;
