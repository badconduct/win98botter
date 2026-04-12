"use strict";

/**
 * Typed wrappers for every Win98 MCP tool, plus the JSON schema definitions
 * used when building the LLM tool list.
 *
 * schemaList() → array of Anthropic-format tool objects
 * openaiSchemaList() → array of OpenAI-format function tool objects
 */

// ── Tool schema definitions ───────────────────────────────────────────────────

const TOOL_SCHEMAS = [
  // ── File Operations ─────────────────────────────────────────────────────────
  {
    name: "read_file",
    description:
      "Read file contents from the Win98SE machine. Returns text (UTF-8) or base64 for binary. For files over 32KB, returns truncated:true and the relay must page through with multiple calls.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path on Win98 machine (e.g. C:\\WINDOWS\\SYSTEM.INI)",
        },
        offset: {
          type: "integer",
          description: "Byte offset to start reading from (default 0)",
        },
        length: {
          type: "integer",
          description: "Bytes to read (default: up to 32KB)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write text content to a file on Win98SE. Automatically backs up the existing file first. Returns the backup path.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute destination path" },
        content: { type: "string", description: "UTF-8 text content to write" },
        backup: {
          type: "boolean",
          description: "Set false only for temp files (default true)",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "write_file_binary",
    description:
      "Write binary data to a file via chunked Base64 transfer. For each chunk: provide b64_chunk, byte_offset, total_size, and set is_final:true on the last chunk.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute destination path" },
        b64_chunk: {
          type: "string",
          description:
            "Base64-encoded chunk of binary data (max ~32KB decoded)",
        },
        byte_offset: {
          type: "integer",
          description: "Target byte offset for this chunk",
        },
        total_size: {
          type: "integer",
          description: "Total file size in bytes",
        },
        is_final: {
          type: "boolean",
          description: "True when this is the last chunk",
        },
      },
      required: ["path", "b64_chunk", "byte_offset", "total_size", "is_final"],
    },
  },
  {
    name: "append_file",
    description:
      "Append text to the end of a file. Creates the file if it does not exist.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path" },
        content: { type: "string", description: "Text to append" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_file",
    description:
      "Delete a file on Win98SE. Automatically backs up the file first (unless it is a temp file).",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path of file to delete",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "copy_file",
    description: "Copy a file on the Win98SE machine.",
    input_schema: {
      type: "object",
      properties: {
        src: { type: "string", description: "Source path" },
        dst: { type: "string", description: "Destination path" },
      },
      required: ["src", "dst"],
    },
  },
  {
    name: "move_file",
    description:
      "Move or rename a file on the Win98SE machine. Backs up before moving.",
    input_schema: {
      type: "object",
      properties: {
        src: { type: "string", description: "Source path" },
        dst: { type: "string", description: "Destination path" },
      },
      required: ["src", "dst"],
    },
  },
  {
    name: "get_file_info",
    description:
      "Get metadata for a file or directory: exists, size, modified date, attributes.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description:
      "List files and subdirectories. Returns names, sizes, and modification dates.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute directory path" },
        pattern: {
          type: "string",
          description: "Wildcard pattern (e.g. *.DLL)",
        },
        recursive: {
          type: "boolean",
          description: "Recurse into subdirectories",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "grep_file",
    description:
      "Search a file for lines matching a pattern. Returns matching lines with line numbers. Far more efficient than reading an entire large file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        pattern: {
          type: "string",
          description: "Text pattern to search for (case-insensitive)",
        },
        max_results: {
          type: "integer",
          description: "Maximum lines to return (default 50)",
        },
      },
      required: ["path", "pattern"],
    },
  },
  {
    name: "list_backups",
    description: "List available backup snapshots for a file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Original file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "restore_backup",
    description: "Restore a file from a specific backup snapshot.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Original file path to restore" },
        timestamp: {
          type: "string",
          description: "Backup timestamp (YYYYMMDD_HHMMSS)",
        },
      },
      required: ["path", "timestamp"],
    },
  },
  {
    name: "get_history",
    description: "Get the recent file change audit log from Win98SE.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum entries to return (default 50)",
        },
        path_filter: {
          type: "string",
          description: "Only show changes to paths matching this prefix",
        },
      },
    },
  },

  // ── INI Operations ──────────────────────────────────────────────────────────
  {
    name: "ini_read",
    description: "Read a single key from an INI file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "INI file path" },
        section: {
          type: "string",
          description: "Section name (without brackets)",
        },
        key: { type: "string", description: "Key name" },
      },
      required: ["path", "section", "key"],
    },
  },
  {
    name: "ini_read_section",
    description: "Read all key-value pairs from one section of an INI file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "INI file path" },
        section: { type: "string", description: "Section name" },
      },
      required: ["path", "section"],
    },
  },
  {
    name: "ini_list_sections",
    description: "List all section names in an INI file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "INI file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "ini_write",
    description: "Write a single key in an INI file. Backs up the file first.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "INI file path" },
        section: { type: "string", description: "Section name" },
        key: { type: "string", description: "Key name" },
        value: { type: "string", description: "New value" },
      },
      required: ["path", "section", "key", "value"],
    },
  },
  {
    name: "ini_delete_key",
    description: "Delete a key from an INI file. Backs up the file first.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "INI file path" },
        section: { type: "string", description: "Section name" },
        key: { type: "string", description: "Key name" },
      },
      required: ["path", "section", "key"],
    },
  },

  // ── Registry Operations ─────────────────────────────────────────────────────
  {
    name: "read_registry",
    description: "Read a registry value from the Win98SE registry.",
    input_schema: {
      type: "object",
      properties: {
        hive: {
          type: "string",
          description: "Hive: HKLM, HKCU, HKCR, HKU, HKCC",
        },
        key: { type: "string", description: "Registry key path" },
        value_name: {
          type: "string",
          description: "Value name (omit for default value)",
        },
      },
      required: ["hive", "key"],
    },
  },
  {
    name: "write_registry",
    description: "Write a registry value.",
    input_schema: {
      type: "object",
      properties: {
        hive: {
          type: "string",
          description: "Hive: HKLM, HKCU, HKCR, HKU, HKCC",
        },
        key: { type: "string", description: "Registry key path" },
        value_name: { type: "string", description: "Value name" },
        data: { type: "string", description: "Data to write (as string)" },
        type: {
          type: "string",
          description: "REG_SZ, REG_DWORD, REG_EXPAND_SZ, REG_BINARY",
        },
      },
      required: ["hive", "key", "value_name", "data", "type"],
    },
  },
  {
    name: "delete_registry",
    description: "Delete a registry value or key.",
    input_schema: {
      type: "object",
      properties: {
        hive: { type: "string", description: "Hive" },
        key: { type: "string", description: "Key path" },
        value_name: {
          type: "string",
          description: "Value name (omit to delete the key itself)",
        },
      },
      required: ["hive", "key"],
    },
  },
  {
    name: "list_registry",
    description: "List subkeys and values under a registry key.",
    input_schema: {
      type: "object",
      properties: {
        hive: { type: "string", description: "Hive" },
        key: { type: "string", description: "Key path" },
      },
      required: ["hive", "key"],
    },
  },

  // ── Process Operations ──────────────────────────────────────────────────────
  {
    name: "list_processes",
    description:
      "List all running processes with their PIDs, names, and memory usage.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "kill_process",
    description: "Terminate a running process by PID or name.",
    input_schema: {
      type: "object",
      properties: {
        pid: { type: "integer", description: "Process ID" },
        name: {
          type: "string",
          description: "Process name (alternative to pid)",
        },
      },
    },
  },

  // ── Execution Operations ────────────────────────────────────────────────────
  {
    name: "run_command",
    description:
      "Run a DOS/Win32 command synchronously. Captures stdout, stderr, and exit code. Times out after 30 seconds. For long-running commands, use start_command instead.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: 'Command to execute (e.g. "dir C:\\WINDOWS")',
        },
        cwd: { type: "string", description: "Working directory" },
        timeout_ms: {
          type: "integer",
          description: "Timeout in milliseconds (default 30000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "run_bat",
    description: "Run an existing .BAT file synchronously.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the .BAT file" },
        args: { type: "string", description: "Command-line arguments" },
        cwd: { type: "string", description: "Working directory" },
        timeout_ms: {
          type: "integer",
          description: "Timeout in milliseconds (default 30000)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_and_run_bat",
    description:
      'Write batch script content to a temporary .BAT file and execute it. Returns bat_path, stdout, stderr, and exit_code. The primary tool for "generate and run a script" tasks.',
    input_schema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Batch script content (@echo off ... del ...)",
        },
        cwd: { type: "string", description: "Working directory" },
        timeout_ms: {
          type: "integer",
          description: "Timeout in milliseconds (default 30000)",
        },
      },
      required: ["content"],
    },
  },

  // ── System Operations ───────────────────────────────────────────────────────
  {
    name: "get_system_info",
    description:
      "Get Win98SE system information: OS version, CPU, RAM, disk drives, NIC, uptime. Always call this first in a new session.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "file_exists",
    description:
      "Check whether a file or directory exists on Win98SE. Returns { exists, is_dir }.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to check" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_disk_info",
    description:
      "Get disk space for all drives: drive letter, total bytes, free bytes. Use to check if disk is full.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_screen_resolution",
    description:
      "Get current display settings: width, height in pixels, colour depth (bpp).",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "set_display_settings",
    description:
      "Change screen resolution and colour depth. Validates the mode is supported by the installed driver before applying.",
    input_schema: {
      type: "object",
      properties: {
        width: {
          type: "integer",
          description: "Horizontal resolution in pixels (e.g. 1024)",
        },
        height: {
          type: "integer",
          description: "Vertical resolution in pixels (e.g. 768)",
        },
        bpp: { type: "integer", description: "Colour depth: 8, 16, 24, or 32" },
        refresh: {
          type: "integer",
          description: "Refresh rate in Hz (optional)",
        },
      },
      required: ["width", "height", "bpp"],
    },
  },
  {
    name: "set_desktop_appearance",
    description:
      "Change desktop wallpaper or background colour. Takes effect immediately without reboot.",
    input_schema: {
      type: "object",
      properties: {
        wallpaper_path: {
          type: "string",
          description: "Absolute path to a .BMP wallpaper file",
        },
        bg_rgb_string: {
          type: "string",
          description: 'Background color as "R G B" (e.g. "0 0 128")',
        },
      },
    },
  },

  // ── Hardware / Ring-0 Operations ────────────────────────────────────────────
  {
    name: "read_port",
    description:
      "Read a hardware I/O port (byte, word, or dword). Win98SE permits direct I/O port access from user-mode. Use with caution.",
    input_schema: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          description: "I/O port address (e.g. 0x3F8 for COM1)",
        },
        size: { type: "string", description: "byte | word | dword" },
      },
      required: ["port", "size"],
    },
  },
  {
    name: "write_port",
    description: "Write a value to a hardware I/O port.",
    input_schema: {
      type: "object",
      properties: {
        port: { type: "integer", description: "I/O port address" },
        value: { type: "integer", description: "Value to write" },
        size: { type: "string", description: "byte | word | dword" },
      },
      required: ["port", "value", "size"],
    },
  },
  {
    name: "load_vxd",
    description: "Dynamically load a VxD driver file.",
    input_schema: {
      type: "object",
      properties: {
        vxd_path: {
          type: "string",
          description: "Absolute path to the .VXD file",
        },
      },
      required: ["vxd_path"],
    },
  },

  // ── Serial / COM Port Operations ────────────────────────────────────────────
  {
    name: "get_comm_port_state",
    description:
      "Get the current configuration of a COM port: baud rate, parity, stop bits, modem signals.",
    input_schema: {
      type: "object",
      properties: {
        port: { type: "string", description: 'COM port name (e.g. "COM1")' },
      },
      required: ["port"],
    },
  },
  {
    name: "read_serial",
    description:
      "Read bytes from a COM port. Returns base64-encoded bytes. Specify timeout_ms for how long to wait.",
    input_schema: {
      type: "object",
      properties: {
        port: { type: "string", description: "COM port name" },
        bytes: { type: "integer", description: "Number of bytes to read" },
        timeout_ms: {
          type: "integer",
          description: "Read timeout in milliseconds (default 2000)",
        },
      },
      required: ["port", "bytes"],
    },
  },
  {
    name: "write_serial",
    description:
      "Write bytes to a COM port. Provide data as a base64-encoded string.",
    input_schema: {
      type: "object",
      properties: {
        port: { type: "string", description: "COM port name" },
        data_b64: {
          type: "string",
          description: "Base64-encoded bytes to send",
        },
      },
      required: ["port", "data_b64"],
    },
  },

  // ── Window / GUI Operations ─────────────────────────────────────────────────
  {
    name: "get_window_list",
    description:
      "List all visible top-level windows with their handles, PIDs, titles, and class names.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "send_window_message",
    description:
      "Post a Windows message to a window handle (e.g. WM_CLOSE = 0x10).",
    input_schema: {
      type: "object",
      properties: {
        hwnd: {
          type: "integer",
          description: "Window handle (from get_window_list)",
        },
        msg: {
          type: "integer",
          description: "Windows message ID (e.g. 0x10 for WM_CLOSE)",
        },
        wparam: { type: "integer", description: "WPARAM (default 0)" },
        lparam: { type: "integer", description: "LPARAM (default 0)" },
      },
      required: ["hwnd", "msg"],
    },
  },
  {
    name: "read_clipboard",
    description: "Read the current clipboard text contents.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  // ── Audio / MIDI Enumeration ────────────────────────────────────────────────
  {
    name: "get_audio_devices",
    description: "List all installed audio input and output devices.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_midi_devices",
    description: "List all installed MIDI input and output devices.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  // ── Task Scheduler ──────────────────────────────────────────────────────────
  {
    name: "schedule_task",
    description:
      "Schedule a command or .BAT file to run at a specific time each day (via Windows AT scheduler). Example: schedule daily temp cleanup at 08:00.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Friendly name for the task (used as a comment)",
        },
        time: {
          type: "string",
          description: 'Time in HH:MM 24-hour format (e.g. "08:00")',
        },
        command: {
          type: "string",
          description: "Full command or path to .BAT file to run",
        },
        days: {
          type: "string",
          description:
            'Days to run: "M,T,W,Th,F" or "M-F" or "every" (default: every day)',
        },
      },
      required: ["name", "time", "command"],
    },
  },
  {
    name: "list_tasks",
    description:
      "List all tasks currently registered with the Windows AT scheduler.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "delete_task",
    description: "Delete a scheduled task by its AT task ID.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Task ID from list_tasks" },
      },
      required: ["id"],
    },
  },

  // ── Async Execution ─────────────────────────────────────────────────────────
  {
    name: "start_command",
    description:
      "Start a long-running command in the background. Returns immediately with a process handle ID. Poll with get_command_status and get_command_output.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Unique ID for this async command (used to poll later)",
        },
        command: { type: "string", description: "Command to run" },
        cwd: { type: "string", description: "Working directory" },
      },
      required: ["id", "command"],
    },
  },
  {
    name: "get_command_status",
    description: "Check whether an async command is still running.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Command ID from start_command" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_command_output",
    description:
      "Read buffered stdout output from a running or completed async command.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Command ID from start_command" },
        max_bytes: {
          type: "integer",
          description: "Maximum bytes to return per call (default 16384)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "stop_command",
    description:
      "Terminate a running async command and release its handle slot.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Command ID from start_command" },
      },
      required: ["id"],
    },
  },
];

/**
 * Return tool schemas in Anthropic format (used when BOT_API_URL points to Anthropic).
 */
function schemaList(allowedTools) {
  if (!allowedTools) return TOOL_SCHEMAS;
  return TOOL_SCHEMAS.filter((t) => allowedTools.includes(t.name));
}

/**
 * Return tool schemas in OpenAI function-calling format.
 */
function openaiSchemaList(allowedTools) {
  return schemaList(allowedTools).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/**
 * Resolve a tool name to its schema.
 */
function getSchema(name) {
  return TOOL_SCHEMAS.find((t) => t.name === name) || null;
}

module.exports = { TOOL_SCHEMAS, schemaList, openaiSchemaList, getSchema };
