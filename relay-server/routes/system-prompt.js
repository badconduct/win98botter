"use strict";

const {
  buildSystemPrompt,
  shouldUseCompactPrompt,
} = require("../agent/context");
const { buildPortfolioPlan } = require("../agent/portfolio");
const { schemaList, filterSchemasForAgent } = require("../win98/tools");
const PermissionsManager = require("../agent/permissions");
const queries = require("../db/queries");

/**
 * GET /api/system-prompt?agent_id=XXX
 *
 * Returns the live system prompt that will be sent to the LLM for this agent.
 * Reads the agent's current permissions from the registry so the tool list
 * shown in the prompt is always accurate.
 */
async function systemPromptRoutes(fastify, opts) {
  const { registry, llm } = opts;

  const DEFAULT_FLAGS = {
    execution_patterns: true,
    crash_protocol: true,
    investigation_first: true,
    platform_notes: true,
    capability_tiers: true,
    sensory_verification: true,
  };

  function normalizeFlags(input) {
    const out = { ...DEFAULT_FLAGS };
    if (!input || typeof input !== "object") return out;
    for (const key of Object.keys(DEFAULT_FLAGS)) {
      if (key in input) out[key] = Boolean(input[key]);
    }
    return out;
  }

  fastify.get(
    "/api/system-prompt",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            request_text: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { agent_id, request_text } = request.query;

      let permissions;
      if (agent_id) {
        const entry = registry.get(agent_id);
        permissions = entry ? entry.permissions : new PermissionsManager();
      } else {
        const def = registry.getDefault();
        permissions = def ? def.permissions : new PermissionsManager();
      }

      const entry = agent_id ? registry.get(agent_id) : registry.getDefault();
      const agentInfo = entry ? entry.connection.agentInfo : null;
      const allSchemas = filterSchemasForAgent(schemaList(), agentInfo);
      const allowedNames = permissions
        .filterSchemas(allSchemas)
        .map((s) => s.name);

      const promptFlags = normalizeFlags(entry ? entry.promptFlags : null);
      const portfolioPlan = request_text
        ? buildPortfolioPlan(request_text, allowedNames)
        : null;
      const prompt = buildSystemPrompt(
        allowedNames,
        permissions,
        agentInfo,
        promptFlags,
        {
          portfolioPlan,
          customPrompt: entry ? entry.customPrompt || "" : "",
          compact: shouldUseCompactPrompt(llm?.apiUrl, llm?.model),
        },
      );
      return reply.send({
        prompt,
        flags: promptFlags,
        custom_prompt: entry ? entry.customPrompt || "" : "",
        permissions: permissions.getAll(),
        portfolioPlan,
      });
    },
  );

  fastify.post(
    "/api/system-prompt/flags",
    {
      schema: {
        body: {
          type: "object",
          required: ["agent_id", "flags"],
          properties: {
            agent_id: { type: "string" },
            flags: {
              type: "object",
              additionalProperties: { type: "boolean" },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { agent_id, flags } = request.body;
      const entry = registry.get(agent_id);
      if (!entry) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      entry.promptFlags = normalizeFlags(flags);
      queries.saveAgentPromptSettings(
        entry.canonicalAgentId || agent_id,
        entry.promptFlags,
        entry.customPrompt || "",
      );
      return reply.send({ success: true, flags: entry.promptFlags });
    },
  );

  fastify.post(
    "/api/system-prompt/custom",
    {
      schema: {
        body: {
          type: "object",
          required: ["agent_id", "custom_prompt"],
          properties: {
            agent_id: { type: "string" },
            custom_prompt: { type: "string", maxLength: 8192 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { agent_id, custom_prompt } = request.body;
      const entry = registry.get(agent_id);
      if (!entry) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      entry.customPrompt = String(custom_prompt || "").trim();
      queries.saveAgentPromptSettings(
        entry.canonicalAgentId || agent_id,
        entry.promptFlags || normalizeFlags(null),
        entry.customPrompt,
      );
      return reply.send({
        success: true,
        custom_prompt: entry.customPrompt,
      });
    },
  );
}

module.exports = systemPromptRoutes;
