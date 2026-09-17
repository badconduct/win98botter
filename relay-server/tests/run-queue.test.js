"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const AgentRunQueue = require("../agent/run-queue");

test("serializes workflows targeting the same physical agent", async () => {
  const queue = new AgentRunQueue();
  const events = [];
  let releaseFirst;
  const waitFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run("host:h4x0r", async () => {
    events.push("first-start");
    await waitFirst;
    events.push("first-end");
  });
  const second = queue.run("host:h4x0r", async () => {
    events.push("second-start");
    events.push("second-end");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "first-start",
    "first-end",
    "second-start",
    "second-end",
  ]);
});

test("allows different agents to run concurrently", async () => {
  const queue = new AgentRunQueue();
  const events = [];
  let releaseA;
  const waitA = new Promise((resolve) => {
    releaseA = resolve;
  });

  const a = queue.run("agent-a", async () => {
    events.push("a-start");
    await waitA;
    events.push("a-end");
  });
  const b = queue.run("agent-b", async () => {
    events.push("b-start");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["a-start", "b-start"]);
  releaseA();
  await Promise.all([a, b]);
});
