"use strict";

/**
 * Win98Connection — wraps a single accepted TCP socket.
 *
 * Handles JSON-RPC framing, pending-call tracking, heartbeat,
 * and the initialize handshake.  Created per socket by Win98Server.
 */

const rpc = require("./rpc");

const CALL_TIMEOUT_MS = 35000;

function isUsefulIdentityValue(v) {
  if (!v) return false;
  const s = String(v).trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  return lower !== "unknown" && lower !== "n/a" && lower !== "none";
}

class Win98Connection {
  /**
   * @param {import('net').Socket} socket
   * @param {object} logger  — pino-compatible logger
   */
  constructor(socket, logger) {
    this.log = logger;
    this.socket = socket;
    this.remoteAddress = socket.remoteAddress;
    this.connected = true;

    // Filled after initialize() completes
    this.agentId = null; // MachineGuid sent by Win98 agent
    this.hostname = null;
    this.agentInfo = null;
    this.lastHeartbeat = null;

    this._pendingCalls = new Map();
    this._nextId = 1;

    this._onDisconnectCb = null;
    this._onHeartbeatCb = null;

    const reader = rpc.createReader((msg) => this._handleIncoming(msg));
    socket.on("data", (chunk) => reader.push(chunk));

    socket.on("close", () => {
      this.connected = false;
      this.socket = null;

      for (const [id, pending] of this._pendingCalls) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Win98 disconnected"));
        this._pendingCalls.delete(id);
      }

      if (this._onDisconnectCb) this._onDisconnectCb(this.agentId);
    });

    socket.on("error", (err) => {
      this.log.error({ err, agentId: this.agentId }, "Win98 socket error");
      socket.destroy();
    });
  }

  _handleIncoming(msg) {
    if (msg.method === "heartbeat") {
      this.lastHeartbeat = Date.now();
      if (this._onHeartbeatCb)
        this._onHeartbeatCb(this.agentId, msg.params || {});
      return;
    }

    if (msg.id !== undefined && msg.id !== null) {
      const pending = this._pendingCalls.get(msg.id);
      if (!pending) {
        this.log.warn(
          { id: msg.id, agentId: this.agentId },
          "Response for unknown call id",
        );
        return;
      }
      clearTimeout(pending.timer);
      this._pendingCalls.delete(msg.id);

      if (msg.error) {
        const err = new Error(msg.error.message || "Win98 RPC error");
        err.code = msg.error.code;
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  call(method, params) {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error("Win98 agent not connected"));
    }

    const id = this._nextId++;
    const msg = rpc.buildRequest(id, method, params || {});

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingCalls.delete(id);
        reject(
          new Error(
            `Win98 tool call timed out: ${method} (${CALL_TIMEOUT_MS}ms)`,
          ),
        );
      }, CALL_TIMEOUT_MS);

      this._pendingCalls.set(id, { resolve, reject, timer });

      try {
        this.socket.write(rpc.encode(msg));
      } catch (err) {
        clearTimeout(timer);
        this._pendingCalls.delete(id);
        reject(err);
      }
    });
  }

  async initialize() {
    const result = await this.call("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "win98botter-relay", version: "0.1.0" },
    });
    this.agentInfo = result;

    // Agent sends machineGuid and hostname in the initialize response.
    // Prefer machineGuid, then hostname, then socket address as a final fallback.
    const machineGuid = result && result.machineGuid;
    const hostname = result && result.hostname;

    this.hostname = isUsefulIdentityValue(hostname)
      ? String(hostname).trim()
      : null;

    if (isUsefulIdentityValue(machineGuid)) {
      this.agentId = String(machineGuid).trim();
    } else if (this.hostname) {
      this.agentId = `host:${this.hostname.toLowerCase()}`;
    } else {
      this.agentId = this.remoteAddress;
    }

    return result;
  }

  async listTools() {
    return this.call("tools/list", {});
  }

  async callTool(name, args) {
    return this.call("tools/call", { name, arguments: args || {} });
  }

  disconnect() {
    if (this.socket) this.socket.destroy();
  }

  onDisconnect(cb) {
    this._onDisconnectCb = cb;
  }
  onHeartbeat(cb) {
    this._onHeartbeatCb = cb;
  }

  getStatus() {
    return {
      agentId: this.agentId,
      hostname: this.hostname,
      connected: this.connected,
      host: this.remoteAddress,
      lastHeartbeat: this.lastHeartbeat,
      agentInfo: this.agentInfo,
    };
  }
}

module.exports = Win98Connection;
