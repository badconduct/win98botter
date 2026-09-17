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

test("TCP peer restriction rejects other addresses before creating an agent", {timeout: 3000}, async () => {
  const previous = process.env.WIN98_ALLOWED_PEERS;
  process.env.WIN98_ALLOWED_PEERS = "192.0.2.10";
  const server = new Win98Server({info(){},warn(){},error(){}});
  let accepted = false;
  server.onConnection(() => { accepted = true; });
  let socket;
  try {
    await server.listen(0,"127.0.0.1");
    socket = net.connect(server._server.address().port,"127.0.0.1");
    await new Promise(resolve => {socket.once("close",resolve);socket.on("error",()=>{});});
    assert.equal(accepted,false);
  } finally {
    if(socket)socket.destroy();
    await server.close();
    if(previous === undefined)delete process.env.WIN98_ALLOWED_PEERS;
    else process.env.WIN98_ALLOWED_PEERS = previous;
  }
});
