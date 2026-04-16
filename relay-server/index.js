"use strict";

/**
 * Win98 Botter - Relay Server
 *
 * Entry point. Binds:
 *   - TCP server: accepts N concurrent Win98 MCP agent connections
 *   - HTTP server (Fastify): REST API + web GUI
 *
 * Start:  node index.js
 * Dev:    node --watch index.js
 */

// -- Load .env (if present) ----------------------------------------------------
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqPos = trimmed.indexOf("=");
    if (eqPos < 1) continue;
    const key = trimmed.slice(0, eqPos).trim();
    const val = trimmed.slice(eqPos + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

// -- Config --------------------------------------------------------------------
const config = {
  botApiUrl: process.env.BOT_API_URL || "",
  botApiKey: process.env.BOT_API_KEY || "",
  botModel: process.env.BOT_MODEL || "gpt-oss:20b",
  win98ListenPort: parseInt(process.env.WIN98_LISTEN_PORT || "9000", 10),
  win98ListenHost: process.env.WIN98_LISTEN_HOST || "0.0.0.0",
  httpPort: parseInt(process.env.HTTP_PORT || "3000", 10),
  httpHost: process.env.HTTP_HOST || "0.0.0.0",
  stagingDir: process.env.STAGING_DIR || path.join(__dirname, "staging_data"),
  dbPath: process.env.DB_PATH || "",
  tokenBudget: parseInt(
    process.env.SESSION_CONTEXT_TOKEN_BUDGET || "80000",
    10,
  ),
  logLevel: process.env.LOG_LEVEL || "info",
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || "",
  heartbeatTimeoutSec: parseInt(process.env.HEARTBEAT_TIMEOUT_SEC || "300", 10),
  watchdogIntervalSec: parseInt(process.env.WATCHDOG_INTERVAL_SEC || "30", 10),
  healthchecksPath: process.env.HEALTHCHECKS_PATH || "",
  phase1PgEnabled: process.env.PHASE1_PG_ENABLED || "0",
  phase1PgUrl: process.env.PHASE1_PG_URL || "",
  phase1PgHost: process.env.PHASE1_PG_HOST || "",
  phase1PgPort: process.env.PHASE1_PG_PORT || "5432",
  phase1PgDatabase: process.env.PHASE1_PG_DATABASE || "win98botter",
  phase1PgUser: process.env.PHASE1_PG_USER || "win98botter",
  phase1PgPassword: process.env.PHASE1_PG_PASSWORD || "win98botter",
  phase1PgSsl: process.env.PHASE1_PG_SSL || "0",
};

// -- Dependencies --------------------------------------------------------------
const Fastify = require("fastify");
const fastifyStatic = require("@fastify/static");

const { initDb } = require("./db/schema");
const { createPhase1Store } = require("./db/phase1-store");
const queries = require("./db/queries");
const Win98Server = require("./win98/client");
const AgentRegistry = require("./win98/registry");
const LLMClient = require("./agent/llm");
const PermissionsManager = require("./agent/permissions");
const StagingManager = require("./staging/manager");
const Watchdog = require("./agent/watchdog");
const AgentLoop = require("./agent/loop");

// -- Initialise database -------------------------------------------------------
initDb(config.dbPath || null);
const phase1Store = createPhase1Store(config, console);

// -- AgentRegistry + Win98Server -----------------------------------------------
const registry = new AgentRegistry();
const win98Server = new Win98Server(console); // logger replaced after fastify init

// -- LLM + Staging -------------------------------------------------------------
const llm = new LLMClient(config.botApiUrl, config.botApiKey, config.botModel);

// -- Shared state (pause/resume) -----------------------------------------------
const state = { paused: false };

// -- Fastify + pino log shim ---------------------------------------------------
//
// We wrap pino's write stream so every log line is also pushed to the registry
// log fan-out (serves the /api/logs SSE endpoint).
//
const { pipeline, Writable } = require("stream");

class LogFanout extends Writable {
  constructor(registry) {
    super();
    this._registry = registry;
  }
  _write(chunk, _encoding, done) {
    const line = chunk.toString();
    // Also write to stdout
    process.stdout.write(line);
    this._registry.pushLog(line.trimEnd());
    done();
  }
}

const fastify = Fastify({
  logger: {
    level: config.logLevel,
    transport: process.stdout.isTTY
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
    stream: process.stdout.isTTY ? undefined : new LogFanout(registry),
  },
});

// Update the TCP server logger after fastify initialises
win98Server.log = fastify.log;

// -- Per-connection agent setup ------------------------------------------------
win98Server.onConnection(async (conn) => {
  conn.log = fastify.log;

  // Run initialize handshake to get the agent's MachineGuid + hostname
  let agentId;
  let registryId;
  try {
    const info = await conn.initialize();
    agentId = conn.agentId;
    fastify.log.info(
      { agentId: conn.agentId, hostname: conn.hostname },
      "Win98 initialize OK",
    );

    // Persist agent identity to DB
    queries.upsertAgent(conn.agentId, conn.hostname, conn.remoteAddress);
  } catch (err) {
    agentId = conn.remoteAddress; // fallback
    conn.agentId = agentId;
    fastify.log.warn(
      { err, fallbackId: agentId },
      "Win98 initialize failed - using IP as ID",
    );
  }

  registryId = agentId;
  if (registry.get(registryId)) {
    registryId = `${agentId}#${Date.now().toString(36)}`;
    fastify.log.warn(
      { canonicalAgentId: agentId, registryId },
      "Duplicate agent identity detected; registered as separate live connection",
    );
  }

  // Create per-agent instances of permissions, staging, and watchdog
  const permissions = new PermissionsManager();
  if (conn.agentInfo && conn.agentInfo.permissions) {
    permissions.update(conn.agentInfo.permissions);
  }

  const staging = new StagingManager(config.stagingDir, conn, fastify.log);

  const watchdog = new Watchdog(
    conn,
    () => new AgentLoop(llm, conn, staging, permissions, fastify.log),
    fastify.log,
    {
      alertWebhookUrl: config.alertWebhookUrl,
      heartbeatTimeoutSec: config.heartbeatTimeoutSec,
      watchdogIntervalSec: config.watchdogIntervalSec,
      healthchecksPath: config.healthchecksPath,
    },
  );

  conn.onHeartbeat((id, params) => {
    fastify.log.debug({ agentId: id, params }, "Win98 heartbeat");
  });

  conn.onDisconnect(() => {
    fastify.log.info(
      { agentId: registryId, canonicalAgentId: agentId },
      "Win98 agent disconnected",
    );
    registry.remove(registryId);
    watchdog.stop();
  });

  registry.register(registryId, {
    connection: conn,
    watchdog,
    agentLoop: null,
    permissions,
    staging,
    canonicalAgentId: agentId,
  });
  watchdog.start();

  fastify.log.info(
    {
      agentId: registryId,
      canonicalAgentId: agentId,
      agentCount: registry.list().length,
    },
    "Agent registered",
  );
});

// -- Static frontend (built React app) ----------------------------------------
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  const indexHtmlPath = path.join(publicDir, "index.html");

  fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    // Don't intercept /api/* routes with static handler
    decorateReply: false,
  });

  // SPA catch-all: unknown non-API paths serve index.html so the React router works
  fastify.setNotFoundHandler((request, reply) => {
    const isApi =
      request.url.startsWith("/api/") ||
      request.url.startsWith("/chat") ||
      request.url.startsWith("/sse") ||
      request.url.startsWith("/history") ||
      request.url.startsWith("/changes") ||
      request.url.startsWith("/undo") ||
      request.url.startsWith("/control") ||
      request.url.startsWith("/health");
    if (isApi) {
      reply.code(404).send({ error: "Not Found", statusCode: 404 });
    } else if (request.url === "/favicon.ico") {
      reply.code(204).send();
    } else {
      reply
        .type("text/html; charset=utf-8")
        .send(fs.readFileSync(indexHtmlPath, "utf8"));
    }
  });

  // First-run redirect: if .env absent, send the index (SPA handles /setup)
  fastify.addHook("onRequest", (request, reply, done) => {
    const isApi =
      request.url.startsWith("/api/") ||
      request.url.startsWith("/chat") ||
      request.url.startsWith("/sse") ||
      request.url.startsWith("/history") ||
      request.url.startsWith("/changes") ||
      request.url.startsWith("/undo") ||
      request.url.startsWith("/control") ||
      request.url.startsWith("/health");
    if (
      !isApi &&
      !fs.existsSync(envPath) &&
      request.url !== "/" &&
      !request.url.startsWith("/assets")
    ) {
      reply.redirect("/");
    }
    done();
  });
}

// -- Route options -------------------------------------------------------------
const routeOpts = {
  registry,
  llm,
  state,
  tokenBudget: config.tokenBudget,
  phase1Store,
};

// -- Register routes -----------------------------------------------------------
fastify.register(require("./routes/health"), routeOpts);
fastify.register(require("./routes/chat"), routeOpts);
fastify.register(require("./routes/sse"), routeOpts);
fastify.register(require("./routes/history"), routeOpts);
fastify.register(require("./routes/changes"), routeOpts);
fastify.register(require("./routes/undo"), routeOpts);
fastify.register(require("./routes/control"), routeOpts);
fastify.register(require("./routes/config"), routeOpts);
fastify.register(require("./routes/logs"), routeOpts);
fastify.register(require("./routes/agents"), routeOpts);
fastify.register(require("./routes/system-prompt"), routeOpts);
fastify.register(require("./routes/map-cache"), routeOpts);
fastify.register(require("./routes/file-activity"), routeOpts);

// -- Start ---------------------------------------------------------------------
async function start() {
  await phase1Store.init();
  await win98Server.listen(config.win98ListenPort, config.win98ListenHost);
  await fastify.listen({ port: config.httpPort, host: config.httpHost });

  fastify.log.info(
    {
      http: `http://${config.httpHost}:${config.httpPort}`,
      tcp: `${config.win98ListenHost}:${config.win98ListenPort}`,
      llm: config.botModel,
      db: config.dbPath || "in-memory",
      phase1Cache: phase1Store.enabled ? "postgres" : "disabled",
    },
    "Win98 Botter relay ready",
  );
}

// -- Graceful shutdown ---------------------------------------------------------
async function shutdown(signal) {
  fastify.log.info({ signal }, "Shutting down...");
  // Stop all per-agent watchdogs
  for (const { agentId, ...entry } of registry.list()) {
    const e = registry.get(agentId);
    if (e && e.watchdog) e.watchdog.stop();
  }
  await phase1Store.close();
  await win98Server.close();
  await fastify.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  fastify.log.error({ reason }, "Unhandled rejection");
});

start().catch((err) => {
  console.error("Failed to start relay server:", err);
  process.exit(1);
});
