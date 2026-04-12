"use strict";

/**
 * GET  /api/config        — return current effective config (redacts secrets)
 * POST /api/config        — write .env and restart or signal hot-reload
 * GET  /api/config/check  — returns { configured: bool } used by first-run check
 */

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env");

const PROVIDERS = ["claude", "openai", "ollama"];

/** True when the URL points at Anthropic's API. */
function isAnthropic(url) {
  return (url || "").includes("anthropic.com");
}

/** Parse a .env file into a plain object. Returns {} if the file is absent. */
function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const obj = {};
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    obj[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return obj;
}

/** Serialise a plain object to .env format. */
function writeEnv(obj) {
  const lines = Object.entries(obj).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf8");
}

async function configRoutes(fastify, opts) {
  // ── GET /api/config/check ──────────────────────────────────────────────────
  fastify.get("/api/config/check", async (_req, reply) => {
    const env = readEnv();
    const configured = !!(env.BOT_API_URL || env.BOT_API_KEY || env.BOT_MODEL);
    return reply.send({ configured });
  });

  // ── GET /api/config ────────────────────────────────────────────────────────
  fastify.get("/api/config", async (_req, reply) => {
    const env = readEnv();
    // Return config with secret redacted
    return reply.send({
      BOT_API_URL: env.BOT_API_URL || "",
      BOT_MODEL: env.BOT_MODEL || "",
      BOT_API_KEY: env.BOT_API_KEY ? "••••••••" : "",
      WIN98_LISTEN_PORT: env.WIN98_LISTEN_PORT || "9000",
      WIN98_LISTEN_HOST: env.WIN98_LISTEN_HOST || "0.0.0.0",
      HTTP_PORT: env.HTTP_PORT || "3000",
      HTTP_HOST: env.HTTP_HOST || "0.0.0.0",
      DB_PATH: env.DB_PATH || "",
      LOG_LEVEL: env.LOG_LEVEL || "info",
      SESSION_CONTEXT_TOKEN_BUDGET: env.SESSION_CONTEXT_TOKEN_BUDGET || "80000",
    });
  });

  // ── POST /api/config ───────────────────────────────────────────────────────
  fastify.post(
    "/api/config",
    {
      schema: {
        body: {
          type: "object",
          required: ["BOT_API_URL", "BOT_MODEL"],
          properties: {
            BOT_API_URL: { type: "string" },
            BOT_MODEL: { type: "string", minLength: 1 },
            BOT_API_KEY: { type: "string" },
            WIN98_LISTEN_PORT: { type: "string" },
            WIN98_LISTEN_HOST: { type: "string" },
            HTTP_PORT: { type: "string" },
            HTTP_HOST: { type: "string" },
            DB_PATH: { type: "string" },
            LOG_LEVEL: {
              type: "string",
              enum: ["trace", "debug", "info", "warn", "error"],
            },
            SESSION_CONTEXT_TOKEN_BUDGET: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;

      const existing = readEnv();

      // Merge: keep existing API key if caller sends the redacted placeholder
      const newEnv = { ...existing };
      for (const [k, v] of Object.entries(body)) {
        if (k === "BOT_API_KEY" && v === "••••••••") continue; // leave existing
        if (v !== "") newEnv[k] = v;
      }

      writeEnv(newEnv);

      // Sync into process.env so new values are available immediately
      for (const [k, v] of Object.entries(newEnv)) process.env[k] = v;

      // Hot-reload the live LLM client — no restart required
      if (opts.llm) {
        opts.llm.apiUrl = newEnv.BOT_API_URL || "";
        opts.llm.apiKey = newEnv.BOT_API_KEY || "";
        opts.llm.model = newEnv.BOT_MODEL || "";
        opts.llm._anthropic = isAnthropic(newEnv.BOT_API_URL);
      }

      fastify.log.info("Config updated via /api/config — applied in-memory");
      return reply.send({ success: true });
    },
  );

  // ── POST /api/config/test ──────────────────────────────────────────────────
  // Test credentials without saving them. Returns { ok, error? }.
  fastify.post(
    "/api/config/test",
    {
      schema: {
        body: {
          type: "object",
          required: ["BOT_API_URL", "BOT_MODEL"],
          properties: {
            BOT_API_URL: { type: "string", minLength: 1 },
            BOT_MODEL: { type: "string", minLength: 1 },
            BOT_API_KEY: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { BOT_API_URL, BOT_API_KEY = "", BOT_MODEL } = request.body;
      fastify.log.info(
        { url: BOT_API_URL, model: BOT_MODEL },
        "LLM connection test started",
      );
      const LLMClient = require("../agent/llm.js");
      const client = new LLMClient(BOT_API_URL, BOT_API_KEY, BOT_MODEL);
      try {
        await client.call(
          [{ role: "user", content: "ping" }],
          [],
          "Respond with the single word: pong",
        );
        fastify.log.info(
          { url: BOT_API_URL, model: BOT_MODEL },
          "LLM connection test OK",
        );
        return reply.send({ ok: true });
      } catch (e) {
        // Node's native fetch wraps network errors in an AggregateError whose
        // real cause (ECONNREFUSED, ENOTFOUND, etc.) is in e.cause.
        const cause =
          e.cause?.message ||
          e.cause?.code ||
          e.errors?.[0]?.message || // AggregateError .errors[]
          e.message ||
          "Unknown error";
        fastify.log.warn(
          { url: BOT_API_URL, model: BOT_MODEL, err: cause },
          "LLM connection test failed",
        );
        return reply.send({ ok: false, error: cause });
      }
    },
  );
}

module.exports = configRoutes;
