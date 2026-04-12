"use strict";

/**
 * Win98Server — TCP listener that accepts multiple concurrent Win98 agent connections.
 *
 * For each accepted socket a Win98Connection is created and passed to the
 * registered onConnection callback so the caller (index.js) can register it
 * with the AgentRegistry and kick off the initialize handshake.
 */

const net = require("net");
const Win98Connection = require("./connection");

class Win98Server {
  constructor(logger) {
    this.log = logger;
    this._server = null;
    this._onConnectionCb = null;
  }

  /**
   * Start the TCP server.  Calls onConnectionCb with each new Win98Connection.
   */
  listen(port, host) {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => {
        const conn = new Win98Connection(socket, this.log);
        this.log.info(
          { addr: socket.remoteAddress },
          "Win98 agent TCP connected",
        );
        if (this._onConnectionCb) this._onConnectionCb(conn);
      });

      this._server.on("error", reject);

      this._server.listen(port, host, () => {
        this.log.info({ port, host }, "Win98 TCP listener ready");
        resolve();
      });
    });
  }

  /** Called with (Win98Connection) each time a socket is accepted. */
  onConnection(cb) {
    this._onConnectionCb = cb;
  }

  close() {
    return new Promise((resolve) => {
      if (this._server) this._server.close(resolve);
      else resolve();
    });
  }
}

module.exports = Win98Server;
