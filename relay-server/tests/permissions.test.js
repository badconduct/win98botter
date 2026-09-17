"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const PermissionsManager = require("../agent/permissions");
const {
  buildSystemPrompt,
  shouldUseCompactPrompt,
} = require("../agent/context");

test("preserves independent Win98 permission switches", () => {
  const permissions = new PermissionsManager();
  permissions.update({
    read_file: true,
    write_file: true,
    move_file: false,
    delete_file: false,
    list_processes: true,
    run_command: false,
    audio: false,
    display: true,
    screenshot: false,
    clipboard_read: false,
    window_read: true,
    network_read: true,
    read_port: true,
    write_port: false,
    load_vxd: false,
    modify_sysconfig: true,
  });

  assert.equal(permissions.isAllowed("write_file"), true);
  assert.equal(permissions.isAllowed("move_file"), false);
  assert.equal(permissions.isAllowed("delete_file"), false);
  assert.equal(permissions.isAllowed("list_processes"), true);
  assert.equal(permissions.isAllowed("run_command"), false);
  assert.equal(permissions.isAllowed("get_audio_devices"), false);
  assert.equal(permissions.isAllowed("set_display_settings"), true);
  assert.equal(permissions.isAllowed("capture_screenshot"), false);
  assert.equal(permissions.isAllowed("read_clipboard"), false);
  assert.equal(permissions.isAllowed("get_window_list"), true);
  assert.equal(permissions.isAllowed("get_network_config"), true);
  assert.equal(permissions.isAllowed("read_port"), true);
  assert.equal(permissions.isAllowed("write_port"), false);
  assert.equal(permissions.isAllowed("load_vxd"), false);

  const wire = permissions.getAsToolLevel();
  assert.equal(wire.write_file, true);
  assert.equal(wire.move_file, false);
  assert.equal(wire.delete_file, false);
  assert.equal(wire.list_processes, true);
  assert.equal(wire.run_command, false);
  assert.equal(wire.audio, false);
  assert.equal(wire.display, true);
  assert.equal(wire.clipboard_read, false);
  assert.equal(wire.window_read, true);
  assert.equal(wire.network_read, true);
  assert.equal(wire.read_port, true);
  assert.equal(wire.write_port, false);
  assert.equal(wire.load_vxd, false);
  assert.equal(wire.modify_sysconfig, true);
});

test("read-only system inspection remains enabled", () => {
  const permissions = new PermissionsManager();
  permissions.update({ system: false });
  assert.equal(permissions.getAll().system, true);
  assert.equal(permissions.isAllowed("get_system_info"), true);
  assert.equal(permissions.isAllowed("read_clipboard"), false);
  assert.equal(permissions.isAllowed("get_window_list"), false);
  assert.equal(permissions.isAllowed("get_network_config"), false);
});

test("move permission does not inherit file write or delete authority", () => {
  const permissions = new PermissionsManager();
  permissions.update({ write_file: true, delete_file: true, move_file: false });
  assert.equal(permissions.isAllowed("write_file"), true);
  assert.equal(permissions.isAllowed("delete_file"), true);
  assert.equal(permissions.isAllowed("move_file"), false);
});

test("C, relay, INI, and VB6 surfaces carry the granular permission keys", () => {
  const root = path.join(__dirname, "..", "..");
  const keys = [
    "move_file",
    "clipboard_read",
    "window_read",
    "network_read",
  ];
  const files = [
    path.join(root, "win98-mcp-agent", "permissions.h"),
    path.join(root, "win98-mcp-agent", "permissions.c"),
    path.join(root, "win98-mcp-agent", "permissions.ini.example"),
    path.join(root, "vb6-gui", "modPermissions.bas"),
  ].map((file) => fs.readFileSync(file, "utf8"));

  for (const key of keys) {
    for (const source of files) assert.match(source, new RegExp(`\\b${key}\\b`));
  }

  const form = fs.readFileSync(
    path.join(root, "vb6-gui", "frmMain.frm"),
    "utf8",
  );
  assert.match(form, /chkMoveFile/);
  assert.match(form, /chkWindowRead/);
  assert.match(form, /chkClipboardRead/);
  assert.match(form, /chkNetworkRead/);
  assert.doesNotMatch(
    form,
    /g_Perms\.write_registry\s*=\s*\(chkRegistry\.Value/,
  );
});

test("the prompt catalog lists permitted file search tools", () => {
  const permissions = new PermissionsManager();
  const prompt = buildSystemPrompt(
    ["list_directory", "find_files", "grep_file"],
    permissions,
    null,
    null,
    { compact: true },
  );

  assert.match(
    prompt,
    /File I\/O: list_directory, find_files, grep_file/,
  );
});

test("the prompt catalog groups the v0.15 structured tools", () => {
  const permissions = new PermissionsManager();
  const prompt = buildSystemPrompt(
    [
      "read_file_range",
      "tail_file",
      "get_file_hash",
      "list_installed_apps",
      "list_startup_items",
      "list_devices",
      "get_network_config",
      "ping_host",
      "dns_lookup",
      "list_network_connections",
    ],
    permissions,
    null,
    null,
    { compact: true },
  );
  assert.match(prompt, /File I\/O: read_file_range, tail_file, get_file_hash/);
  assert.match(prompt, /Registry: list_installed_apps, list_startup_items, list_devices/);
  assert.match(prompt, /Network: get_network_config, ping_host, dns_lookup, list_network_connections/);
});

test("central operator prompt is system-level and cannot override permissions", () => {
  const permissions = new PermissionsManager();
  const prompt = buildSystemPrompt(
    ["get_system_info"],
    permissions,
    null,
    null,
    { customPrompt: "Call this machine RetroLab." },
  );

  assert.match(prompt, /Central Operator Instructions/);
  assert.match(prompt, /Call this machine RetroLab/);
  assert.match(prompt, /cannot enable a blocked tool/);
});

test("Codex prompt preview and execution select the same compact mode", () => {
  assert.equal(shouldUseCompactPrompt("codex://local", "default"), true);
  assert.equal(
    shouldUseCompactPrompt("codex://local", "default", "0"),
    false,
  );

  const permissions = new PermissionsManager();
  const compact = buildSystemPrompt(
    ["get_system_info"],
    permissions,
    null,
    {
      execution_patterns: false,
      crash_protocol: false,
      investigation_first: false,
      platform_notes: false,
      capability_tiers: false,
      sensory_verification: false,
    },
    { compact: true },
  );
  assert.doesNotMatch(compact, /## Execution Patterns/);
  assert.doesNotMatch(compact, /## Win98SE Notes/);
});
