"use strict";

/**
 * AgentRegistry — tracks all currently connected (and recently seen) Win98 agents.
 *
 * Each entry keyed by a registry agentId (tab/connection id) holds:
 *   { connection, watchdog, agentLoop, permissions, canonicalAgentId, promptFlags }
 *
 * Also maintains an in-memory ring-buffer of log lines for the GUI's log SSE
 * endpoint, and a list of SSE subscribers to fan-out logs in real time.
 */

const MAX_LOG_BUFFER = 500; // keep last 500 log lines in memory

class AgentRegistry {
  constructor() {
    this._agents = new Map(); // agentId → entry
    this._logBuffer = []; // ring buffer of log strings
    this._logSubscribers = new Set(); // live SSE subscribers: { res, agentId }
  }

  // ── Agent management ────────────────────────────────────────────────────────

  register(
    agentId,
    {
      connection,
      watchdog,
      agentLoop,
      permissions,
      canonicalAgentId,
      promptFlags,
    },
  ) {
    this._agents.set(agentId, {
      connection,
      watchdog,
      agentLoop,
      permissions,
      canonicalAgentId: canonicalAgentId || agentId,
      promptFlags: promptFlags || null,
    });
  }

  remove(agentId) {
    this._agents.delete(agentId);
  }

  get(agentId) {
    return this._agents.get(agentId) || null;
  }

  /** Return the first connected agent, or null — used when no agent_id param provided. */
  getDefault() {
    for (const [agentId, entry] of this._agents) {
      if (entry.connection.connected) return { agentId, ...entry };
    }
    return null;
  }

  /** Returns the connection object for the given agentId (convenience). */
  getConnection(agentId) {
    const entry = this._agents.get(agentId);
    return entry ? entry.connection : null;
  }

  list() {
    const result = [];
    for (const [agentId, entry] of this._agents) {
      const online = !!entry.connection.connected;
      result.push({
        agentId,
        canonicalAgentId: entry.canonicalAgentId || agentId,
        hostname: entry.connection.hostname,
        host: entry.connection.remoteAddress,
        connected: online,
        online,
        lastHeartbeat: entry.connection.lastHeartbeat,
        agentInfo: entry.connection.agentInfo,
      });
    }
    return result;
  }

  // ── Log fan-out ─────────────────────────────────────────────────────────────

  /**
   * Push a log line string to all connected SSE subscribers and the ring buffer.
   * Called from the pino destination shim in index.js.
   */
  pushLog(line) {
    this._logBuffer.push(line);
    if (this._logBuffer.length > MAX_LOG_BUFFER) {
      this._logBuffer.shift();
    }

    for (const sub of this._logSubscribers) {
      try {
        if (sub.agentId && !this._lineMatchesAgent(line, sub.agentId)) {
          continue;
        }
        sub.res.write(`data: ${line}\n\n`);
      } catch (_) {
        this._logSubscribers.delete(sub);
      }
    }
  }

  /** Returns the buffered log lines (for initial SSE burst). */
  getLogBuffer() {
    return this._logBuffer.slice();
  }

  addLogSubscriber(res, agentId) {
    this._logSubscribers.add({ res, agentId: agentId || null });
  }

  removeLogSubscriber(res) {
    for (const sub of this._logSubscribers) {
      if (sub.res === res) {
        this._logSubscribers.delete(sub);
      }
    }
  }

  _lineMatchesAgent(line, agentId) {
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
}

module.exports = AgentRegistry;
