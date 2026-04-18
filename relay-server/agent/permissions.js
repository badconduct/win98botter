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
 *   hardware_io=0
 *   serial=1
 *   scheduler=1
 *
 * Tool-to-category mapping is defined here.
 */

const TOOL_PERMISSIONS = {
  // file_read
  read_file: "file_read",
  get_file_info: "file_read",
  list_directory: "file_read",
  grep_file: "file_read",
  list_backups: "file_read",
  get_history: "file_read",
  ini_read: "file_read",
  ini_read_section: "file_read",
  ini_list_sections: "file_read",

  // file_write
  write_file: "file_write",
  write_file_binary: "file_write",
  append_file: "file_write",
  delete_file: "file_write",
  copy_file: "file_write",
  move_file: "file_write",
  restore_backup: "file_write",
  ini_write: "file_write",
  ini_delete_key: "file_write",

  // registry_read
  read_registry: "registry_read",
  list_registry: "registry_read",

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
  list_processes: "execute", // read-only — allow with execute
  kill_process: "process_kill",

  // hardware_io
  read_port: "hardware_io",
  write_port: "hardware_io",
  load_vxd: "hardware_io",

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
  set_display_settings: "system",
  set_desktop_appearance: "system",
  get_window_list: "system",
  send_window_message: "system",
  read_clipboard: "system",
  capture_screenshot: "screenshot",
  get_audio_devices: "system",
  get_midi_devices: "system",
};

class PermissionsManager {
  constructor() {
    // Defaults: read operations on, write/execute off
    this._perms = {
      file_read: true,
      file_write: false,
      registry_read: true,
      registry_write: false,
      execute: false,
      process_kill: false,
      hardware_io: false,
      serial: false,
      scheduler: false,
      screenshot: false,
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
      delete_file: "file_write",
      list_processes: "execute",
      kill_process: "process_kill",
      run_command: "execute",
      read_registry: "registry_read",
      write_registry: "registry_write",
      read_port: "hardware_io",
      write_port: "hardware_io",
      load_vxd: "hardware_io",
      serial: "serial",
      scheduler: "scheduler",
      screenshot: "screenshot",
      audio: "system",
      display: "system",
    };

    for (const [key, val] of Object.entries(permObj)) {
      const boolVal = Boolean(
        val === true || val === 1 || val === "1" || val === "true",
      );

      if (key in this._perms) {
        this._perms[key] = boolVal;
        continue;
      }

      if (key in toolLevelToCategory) {
        this._perms[toolLevelToCategory[key]] = boolVal;
      }
    }
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
    toolLevel.delete_file = this._perms.file_write;
    toolLevel.list_processes = this._perms.execute;
    toolLevel.kill_process = this._perms.process_kill;
    toolLevel.run_command = this._perms.execute;
    toolLevel.read_registry = this._perms.registry_read;
    toolLevel.write_registry = this._perms.registry_write;
    toolLevel.read_port = this._perms.hardware_io;
    toolLevel.write_port = this._perms.hardware_io;
    toolLevel.load_vxd = this._perms.hardware_io;
    toolLevel.modify_sysconfig = this._perms.file_write;
    toolLevel.serial = this._perms.serial;
    toolLevel.scheduler = this._perms.scheduler;
    toolLevel.screenshot = this._perms.screenshot;
    toolLevel.audio = this._perms.system;
    toolLevel.display = this._perms.system;

    return toolLevel;
  }
}

module.exports = PermissionsManager;
