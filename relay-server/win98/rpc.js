"use strict";

/**
 * JSON-RPC 2.0 framing over raw TCP.
 *
 * Wire format: [4-byte big-endian uint32 message length][UTF-8 JSON payload]
 *
 * This module handles serialisation, deserialisation, and incremental
 * reassembly of fragmented TCP reads into complete JSON-RPC messages.
 */

const HEADER_SIZE = 4; // bytes for the length prefix

/**
 * Encode a JSON-RPC message for transmission.
 * @param {object} msg
 * @returns {Buffer}
 */
function encode(msg) {
  const payload = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.allocUnsafe(HEADER_SIZE);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Incremental reader — buffers incoming TCP data and fires a callback
 * each time a complete message is available.
 *
 * Usage:
 *   const reader = createReader((msg) => { ... });
 *   socket.on('data', (chunk) => reader.push(chunk));
 */
function createReader(onMessage) {
  let buf = Buffer.alloc(0);

  function push(chunk) {
    buf = Buffer.concat([buf, chunk]);

    while (true) {
      if (buf.length < HEADER_SIZE) break;

      const msgLen = buf.readUInt32BE(0);

      // Guard against absurd message sizes (16 MB max)
      if (msgLen > 16 * 1024 * 1024) {
        buf = Buffer.alloc(0);
        break;
      }

      if (buf.length < HEADER_SIZE + msgLen) break;

      const payload = buf.slice(HEADER_SIZE, HEADER_SIZE + msgLen);
      buf = buf.slice(HEADER_SIZE + msgLen);

      let msg;
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch (_) {
        // Malformed JSON — skip this message
        continue;
      }

      onMessage(msg);
    }
  }

  return { push };
}

/**
 * Build a JSON-RPC 2.0 request object.
 */
function buildRequest(id, method, params) {
  return { jsonrpc: "2.0", id, method, params: params || {} };
}

/**
 * Build a JSON-RPC 2.0 notification (no id — no response expected).
 */
function buildNotification(method, params) {
  return { jsonrpc: "2.0", method, params: params || {} };
}

/**
 * Build a JSON-RPC 2.0 success response.
 */
function buildResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/**
 * Build a JSON-RPC 2.0 error response.
 */
function buildError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}

module.exports = {
  encode,
  createReader,
  buildRequest,
  buildNotification,
  buildResult,
  buildError,
};
