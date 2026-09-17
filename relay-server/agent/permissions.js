"use strict";

/**
 * Permissions enforcement layer.
 *
 * The Win98 agent reads permissions.ini on startup and only advertises
 * permitted tools in tools/list. The relay enforces the same rules on its
 * side as a second layer of defence.
 *
 * permissions.ini format (on the relay, a local copy synced from Win98):
 *
 *   [permissions]
 *   file_read=1
 *   file_write=0
 *   registry_read=1
 *   registry_write=0
 *   execute=1
 *   process_kill=0
 *   hardware_read=0
 *   hardware_write=0
 *   vxd_load=0
 *   serial=1
 *   scheduler=1
 *
 * Tool-to-category mapping is defined here.
 */

const TOOL_PERMISSIONS = {
  // file_read
  read_file: "file_read",
  read_file_range: "file_read",
  tail_file: "file_read",
  get_file_hash: "file_read",
  get_file_info: "file_read",
  list_directory: "file_read",
  find_files: "file_read",
  grep_file: "file_read",
  get_history: "file_read",
  ini_read: "file_read",
  ini_read_section: "file_read",
  ini_list_sections: "file_read",

  // file_write
  write_file: "file_write",
  write_file_binary: "file_write",
  append_file: "file_write",
  copy_file: "file_write",
  ini_write: "file_write",
  ini_delete_key: "file_write",

  // Moving removes the source path and is intentionally independent of writes.
  move_file: "file_move",

  // file_delete (independent on the Win98 agent)
  delete_file: "file_delete",

  // registry_read
  read_registry: "registry_read",
  list_registry: "registry_read",
  list_installed_apps: "registry_read",
  list_startup_items: "registry_read",
  list_devices: "registry_read",

  // registry_write
  write_registry: "registry_write",
  delete_registry: "registry_write",

  // execute
  run_command: "execute",
  run_bat: "execute",
  write_and_run_bat: "execute",
  start_command: "execute",
  get_command_status: "execute",
  get_command_output: "execute",
  stop_command: "execute",

  // process_kill
  list_processes: "process_list",
  kill_process: "process_kill",

  // Native Win98 hardware switches remain independent.
  read_port: "hardware_read",
  write_port: "hardware_write",
  load_vxd: "vxd_load",

  // serial
  get_comm_port_state: "serial",
  read_serial: "serial",
  write_serial: "serial",

  // scheduler
  schedule_task: "scheduler",
  list_tasks: "scheduler",
  delete_task: "scheduler",

  // system — always allowed if agent is connected
  get_system_info: "system",
  file_exists: "file_read",
  get_disk_info: "system",
  get_screen_resolution: "system",
  get_window_list: "window_read",
  read_clipboard: "clipboard_read",
  capture_screenshot: "screenshot",
  get_audio_devices: "audio",
  get_midi_devices: "audio",

  // display/UI control (independent on the Win98 agent)
  set_display_settings: "display",
  set_desktop_appearance: "display",
  send_window_message: "display",

  // Structured read-only network diagnostics.
  get_network_config: "network_read",
  ping_host: "network_read",
  dns_lookup: "network_read",
  list_network_connections: "network_read",
};

class PermissionsManager {
  constructor() {
    // Defaults: read operations on, write/execute off
    this._perms = {
      file_read: true,
      file_write: false,
      file_move: false,
      file_delete: false,
      registry_read: true,
      registry_write: false,
      execute: false,
      process_list: false,
      process_kill: false,
      hardware_read: false,
      hardware_write: false,
      vxd_load: false,
      system_config: false,
      serial: false,
      scheduler: false,
      audio: false,
      display: false,
      screenshot: false,
      clipboard_read: false,
      window_read: false,
      network_read: false,
      system: true,
    };
  }

  /**
   * Update permissions from a plain key-value object.
   * Typically sourced from the Win98 agent's initialize response
   * or from the VB6 GUI via POST /control.
   */
  update(permObj) {
    const toolLevelToCategory = {
      read_file: "file_read",
      write_file: "file_write",
      move_file: "file_move",
      delete_file: "file_delete",
      list_processes: "process_list",
      kill_process: "process_kill",
      run_command: "execute",
      read_registry: "registry_read",
      write_registry: "registry_write",
      read_port: "hardware_read",
      write_port: "hardware_write",
      load_vxd: "vxd_load",
      modify_sysconfig: "system_config",
      serial: "serial",
      scheduler: "scheduler",
      audio: "audio",
      display: "display",
      screenshot: "screenshot",
      clipboard_read: "clipboard_read",
      window_read: "window_read",
      network_read: "network_read",
    };

    for (const [key, val] of Object.entries(permObj)) {
      const boolVal = Boolean(
        val === true || val === 1 || val === "1" || val === "true",
      );

      // Backward-compatible aggregate accepted from older web clients.
      if (key === "hardware_io") {
        this._perms.hardware_read = boolVal;
        this._perms.hardware_write = boolVal;
        this._perms.vxd_load = boolVal;
        continue;
      }

      if (key in this._perms) {
        if (key === "system") {
          this._perms.system = boolVal;
        } else {
          this._perms[key] = boolVal;
        }
        continue;
      }

      if (key in toolLevelToCategory) {
        this._perms[toolLevelToCategory[key]] = boolVal;
      }
    }

    // Only the narrow, non-sensitive system inspection category is immutable.
    // Clipboard, window, network, file, and device reads remain separately gated.
    this._perms.system = true;
  }

  /**
   * Returns true if the named tool is permitted.
   */
  isAllowed(toolName) {
    const category = TOOL_PERMISSIONS[toolName];
    if (!category) return false; // unknown tool
    return this._perms[category] !== false;
  }

  /**
   * Return the category name for a tool.
   */
  categoryOf(toolName) {
    return TOOL_PERMISSIONS[toolName] || null;
  }

  /**
   * Filter a tool schema list down to only permitted tools.
   */
  filterSchemas(schemas) {
    return schemas.filter((s) => this.isAllowed(s.name));
  }

  getAll() {
    return { ...this._perms };
  }

  /**
   * Return permissions in tool-level format for sending to Win98 agent.
   * The agent expects tool-level keys (read_file, write_file, run_command, etc.)
   * not category-level keys (file_read, file_write, execute, etc.)
   */
  getAsToolLevel() {
    const toolLevel = {};

    // Map categories back to tool-level keys in the same order as the agent sends them
    toolLevel.read_file = this._perms.file_read;
    toolLevel.write_file = this._perms.file_write;
    toolLevel.move_file = this._perms.file_move;
    toolLevel.delete_file = this._perms.file_delete;
    toolLevel.list_processes = this._perms.process_list;
    toolLevel.kill_process = this._perms.process_kill;
    toolLevel.run_command = this._perms.execute;
    toolLevel.read_registry = this._perms.registry_read;
    toolLevel.write_registry = this._perms.registry_write;
    toolLevel.read_port = this._perms.hardware_read;
    toolLevel.write_port = this._perms.hardware_write;
    toolLevel.load_vxd = this._perms.vxd_load;
    toolLevel.modify_sysconfig = this._perms.system_config;
    toolLevel.serial = this._perms.serial;
    toolLevel.scheduler = this._perms.scheduler;
    toolLevel.screenshot = this._perms.screenshot;
    toolLevel.audio = this._perms.audio;
    toolLevel.display = this._perms.display;
    toolLevel.clipboard_read = this._perms.clipboard_read;
    toolLevel.window_read = this._perms.window_read;
    toolLevel.network_read = this._perms.network_read;

    return toolLevel;
  }
}

module.exports = PermissionsManager;
