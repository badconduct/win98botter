"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCodexPrompt,
  isCodexCliUrl,
  normalizeCodexResponse,
} = require("../agent/codex-cli");
const {
  isLoopbackHost,
  openAiResponse,
  parseArgs,
  startBridge,
  tokenMatches,
} = require("../codex-bridge");

const tools = [
  {
    type: "function",
    function: {
      name: "get_system_info",
      description: "Get system information",
      parameters: { type: "object", properties: {} },
    },
  },
];

test("recognizes only explicit Codex CLI URLs", () => {
  assert.equal(isCodexCliUrl("codex://local"), true);
  assert.equal(isCodexCliUrl("chatgpt-cli://local"), true);
  assert.equal(isCodexCliUrl("https://api.openai.com/v1"), false);
});

test("builds a prompt containing the remote tool contract and conversation", () => {
  const prompt = buildCodexPrompt(
    [{ role: "user", content: "Inspect the machine" }],
    tools,
    "Be concise",
  );
  assert.match(prompt, /remote Windows 98 tools/);
  assert.match(prompt, /get_system_info/);
  assert.match(prompt, /Inspect the machine/);
  assert.match(prompt, /Be concise/);
});

test("normalizes valid tool calls and removes unadvertised tools", () => {
  const result = normalizeCodexResponse(
    {
      stop_reason: "tool_use",
      text: "",
      tool_calls: [
        { id: "call-1", name: "get_system_info", input_json: "{}" },
        { id: "call-2", name: "delete_everything", input_json: "{}" },
      ],
    },
    tools,
    "prompt",
  );

  assert.equal(result.stop_reason, "tool_use");
  assert.deepEqual(result.tool_calls, [
    { id: "call-1", name: "get_system_info", input: {} },
  ]);
  assert.equal(result._openai_message.tool_calls.length, 1);
});

test("rejects an empty response with no valid tool call", () => {
  assert.throws(
    () =>
      normalizeCodexResponse(
        { stop_reason: "end_turn", text: "", tool_calls: [] },
        tools,
        "prompt",
      ),
    /neither text nor a valid remote tool call/,
  );
});

test("maps a normalized result to an OpenAI-compatible response", () => {
  const normalized = normalizeCodexResponse(
    { stop_reason: "end_turn", text: "Done", tool_calls: [] },
    tools,
    "prompt",
  );
  const response = openAiResponse(normalized, "default");
  assert.equal(response.choices[0].finish_reason, "stop");
  assert.equal(response.choices[0].message.content, "Done");
  assert.equal(response.model, "default");
});

test("bridge argument and token guards are deterministic", () => {
  const options = parseArgs([
    "--host",
    "0.0.0.0",
    "--port",
    "9001",
    "--model",
    "default",
  ]);
  assert.equal(options.host, "0.0.0.0");
  assert.equal(options.port, 9001);
  assert.equal(isLoopbackHost(options.host), false);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(tokenMatches("secret", "secret"), true);
  assert.equal(tokenMatches("secret", "wrong"), false);
});

test("bridge refuses a non-loopback listener without a token", async () => {
  await assert.rejects(
    () =>
      startBridge({
        host: "0.0.0.0",
        port: 8787,
        command: "codex",
        model: "default",
        timeoutMs: 1000,
        token: "",
      }),
    /CODEX_BRIDGE_TOKEN is required/,
  );
});
