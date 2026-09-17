"use strict";

/**
 * Local OpenAI-compatible bridge backed by an authenticated Codex CLI.
 *
 * This process is intended to run on the Windows host when the relay itself
 * runs in Docker. The container reaches it through host.docker.internal.
 */

const crypto = require("crypto");
const http = require("http");
const { CodexCliClient } = require("./agent/codex-cli");

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function parseArgs(argv) {
  const options = {
    host: process.env.CODEX_BRIDGE_HOST || "127.0.0.1",
    port: parseInt(process.env.CODEX_BRIDGE_PORT || "8787", 10),
    command: process.env.BOT_CODEX_COMMAND || "codex",
    model: process.env.BOT_CODEX_MODEL || "default",
    timeoutMs:
      parseInt(process.env.BOT_CODEX_TIMEOUT_MS || "", 10) || 180000,
    token: process.env.CODEX_BRIDGE_TOKEN || "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--host") options.host = argv[++i];
    else if (arg === "--port") options.port = parseInt(argv[++i], 10);
    else if (arg === "--codex") options.command = argv[++i];
    else if (arg === "--model") options.model = argv[++i];
    else if (arg === "--timeout-ms") options.timeoutMs = parseInt(argv[++i], 10);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.host) throw new Error("Bridge host cannot be blank");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("Bridge port must be between 1 and 65535");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("Codex timeout must be at least 1000 ms");
  }
  return options;
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function tokenMatches(expected, provided) {
  if (!expected) return true;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided || "", "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(request) {
  const header = String(request.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error("Request body is too large");
        err.statusCode = 413;
        reject(err);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        const err = new Error("Request body must be valid JSON");
        err.statusCode = 400;
        reject(err);
      }
    });
    request.on("error", reject);
  });
}

function openAiResponse(result, model) {
  return {
    id: `chatcmpl-codex-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "codex-cli",
    choices: [
      {
        index: 0,
        message: result._openai_message,
        finish_reason:
          result.stop_reason === "tool_use" ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage.input_tokens,
      completion_tokens: result.usage.output_tokens,
      total_tokens: result.usage.input_tokens + result.usage.output_tokens,
    },
  };
}

function helpText() {
  return [
    "Win98Botter Codex CLI bridge",
    "",
    "Usage: node codex-bridge.js [options]",
    "",
    "  --host HOST         Listen address (default 127.0.0.1)",
    "  --port PORT         Listen port (default 8787)",
    "  --codex PATH        Codex executable (default codex)",
    "  --model MODEL       Codex model or 'default'",
    "  --timeout-ms MS     Per-call timeout (default 180000)",
    "  --help              Show this help",
    "",
    "Set CODEX_BRIDGE_TOKEN when binding beyond loopback. Pass the same value",
    "as BOT_API_KEY in the relay. Do not put the token directly on the command line.",
  ].join("\n");
}

async function startBridge(options) {
  if (!isLoopbackHost(options.host) && !options.token) {
    throw new Error(
      "CODEX_BRIDGE_TOKEN is required when the bridge listens beyond loopback",
    );
  }

  const defaultClient = new CodexCliClient({
    command: options.command,
    model: options.model,
    timeoutMs: options.timeoutMs,
  });
  const status = await defaultClient.status();

  const server = http.createServer(async (request, response) => {
    if (!tokenMatches(options.token, bearerToken(request))) {
      sendJson(response, 401, { error: { message: "Unauthorized" } });
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        provider: "codex-cli",
        authenticated: true,
      });
      return;
    }

    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      sendJson(response, 404, { error: { message: "Not found" } });
      return;
    }

    try {
      const body = await readJsonBody(request);
      if (!Array.isArray(body.messages)) {
        sendJson(response, 400, {
          error: { message: "messages must be an array" },
        });
        return;
      }

      const systemPrompt = body.messages
        .filter((message) => message && message.role === "system")
        .map((message) => String(message.content || ""))
        .join("\n\n");
      const messages = body.messages.filter(
        (message) => !message || message.role !== "system",
      );
      const requestedModel = String(body.model || options.model || "default");
      const client =
        requestedModel === options.model
          ? defaultClient
          : new CodexCliClient({
              command: options.command,
              model: requestedModel,
              timeoutMs: options.timeoutMs,
            });
      const result = await client.call(messages, body.tools || [], systemPrompt);
      sendJson(response, 200, openAiResponse(result, requestedModel));
    } catch (err) {
      // A structured Codex/auth/configuration failure is not made healthier by
      // having the relay immediately launch the CLI three more times.
      const statusCode = err.statusCode || (err.retriable === false ? 422 : 502);
      sendJson(response, statusCode, {
        error: { message: err.message || "Codex CLI bridge error" },
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });

  return { server, status };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText() + "\n");
    return;
  }
  const { server, status } = await startBridge(options);
  process.stdout.write(
    `[codex-bridge] ${status.detail}\n[codex-bridge] Listening on http://${options.host}:${options.port}\n`,
  );

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[codex-bridge] ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  helpText,
  isLoopbackHost,
  openAiResponse,
  parseArgs,
  startBridge,
  tokenMatches,
};
