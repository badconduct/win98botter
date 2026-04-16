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
    const agentId =
      request.query && request.query.agent_id
        ? String(request.query.agent_id)
        : null;

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    // Burst the existing buffer to the new subscriber
    for (const line of registry.getLogBuffer()) {
      if (shouldEmitLogLine(line, agentId)) {
        reply.raw.write(`data: ${line}\n\n`);
      }
    }

    registry.addLogSubscriber(reply.raw, agentId);

    // Clean up when the client disconnects
    request.raw.on("close", () => {
      registry.removeLogSubscriber(reply.raw);
    });

    // Keep the response open (never resolve)
    await new Promise(() => {});
  });
}

function shouldEmitLogLine(line, agentId) {
  if (!agentId) return true;
  if (!line) return false;

  try {
    const obj = JSON.parse(line);
    if (obj.agentId && String(obj.agentId) === agentId) return true;
    if (obj.canonicalAgentId && String(obj.canonicalAgentId) === agentId)
      return true;
    return false;
  } catch (_) {
    return line.indexOf(agentId) !== -1;
  }
}

module.exports = logsRoutes;
