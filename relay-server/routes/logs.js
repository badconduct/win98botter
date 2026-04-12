"use strict";

/**
 * GET /api/logs
 *
 * Server-Sent Events stream of pino log output.
 *
 * On connect: immediately receives the last 500 buffered log lines,
 * then continues to receive live updates pushed by the AgentRegistry.
 */

async function logsRoutes(fastify, opts) {
  const { registry } = opts;

  fastify.get("/api/logs", async (request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    // Burst the existing buffer to the new subscriber
    for (const line of registry.getLogBuffer()) {
      reply.raw.write(`data: ${line}\n\n`);
    }

    registry.addLogSubscriber(reply.raw);

    // Clean up when the client disconnects
    request.raw.on("close", () => {
      registry.removeLogSubscriber(reply.raw);
    });

    // Keep the response open (never resolve)
    await new Promise(() => {});
  });
}

module.exports = logsRoutes;
