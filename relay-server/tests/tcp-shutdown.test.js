"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const Win98Server = require("../win98/client");

test("relay closes connected agent sockets during shutdown", {timeout: 3000}, async () => {
  const server = new Win98Server({info(){},warn(){},error(){}});
  await server.listen(0,"127.0.0.1");
  const socket = net.connect(server._server.address().port,"127.0.0.1");
  try {
    await new Promise((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
    await server.close();
    assert.equal(server._server.listening,false);
  } finally {socket.destroy();}
});
