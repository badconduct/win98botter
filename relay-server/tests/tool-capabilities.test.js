"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  TOOL_SCHEMAS,
  advertisedToolNames,
  filterSchemasForAgent,
  isToolAdvertised,
} = require("../win98/tools");

test("relay exposes one unique schema for every v0.15 native dispatcher tool", () => {
  assert.equal(TOOL_SCHEMAS.length, 61);
  assert.equal(new Set(TOOL_SCHEMAS.map((tool) => tool.name)).size, 61);

  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "win98-mcp-agent", "mcp_server.c"),
    "utf8",
  );
  const dispatcher = new Set(
    [...source.matchAll(/\{\s*"([a-z0-9_]+)"\s*,\s*(?:tool_|fn_)/g)].map(
      (match) => match[1],
    ),
  );
  const schemas = new Set(TOOL_SCHEMAS.map((tool) => tool.name));
  assert.deepEqual([...dispatcher].sort(), [...schemas].sort());
});

test("capability filtering supports object and string advertisements", () => {
  const info = { tools: [{ name: "get_system_info" }, "tail_file"] };
  assert.deepEqual(
    [...advertisedToolNames(info)].sort(),
    ["get_system_info", "tail_file"],
  );
  assert.deepEqual(
    filterSchemasForAgent(TOOL_SCHEMAS, info).map((tool) => tool.name),
    ["tail_file", "get_system_info"],
  );
  assert.equal(isToolAdvertised(info, "tail_file"), true);
  assert.equal(isToolAdvertised(info, "get_file_hash"), false);
});

test("legacy initialize payload without tools retains compatibility", () => {
  assert.equal(advertisedToolNames({ serverInfo: { version: "0.13" } }), null);
  assert.equal(
    filterSchemasForAgent(TOOL_SCHEMAS, {}).length,
    TOOL_SCHEMAS.length,
  );
});
