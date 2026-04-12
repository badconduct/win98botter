"use strict";

/**
 * mock-win98.js — Local test harness
 *
 * Simulates a Win98SE MCP agent connecting to the relay server over TCP.
 * Supports all core tools with plausible fake data so you can develop and
 * test the relay without real Win98 hardware.
 *
 * Usage:
 *   node test/mock-win98.js
 *
 * In a second terminal run the relay:
 *   node index.js
 *
 * Then send a chat message:
 *   curl -s -X POST http://localhost:3000/chat \
 *     -H "Content-Type: application/json" \
 *     -d '{"session_id":"test-1","message":"what processes are running?"}' | jq
 */

const net = require("net");
const path = require("path");

// ── Bootstrap: reuse the relay rpc helpers ────────────────────────────────────
const {
  encode,
  createReader,
  buildResult,
  buildError,
  buildNotification,
} = require(path.join(__dirname, "..", "win98", "rpc"));

// ── Config ────────────────────────────────────────────────────────────────────
const HOST = process.env.WIN98_RELAY_HOST || "127.0.0.1";
const PORT = parseInt(process.env.WIN98_LISTEN_PORT || "9000", 10);
const HEARTBEAT_INTERVAL_MS = 60_000;

// ── Mock data ─────────────────────────────────────────────────────────────────
const SYSTEM_INFO = {
  os: "Windows 98 Second Edition",
  version: "4.10.2222",
  computer: "WIN98PC",
  user: "Administrator",
  processor: "Intel Pentium II 350 MHz",
  ram_total: 131072,
  ram_free: 64512,
  drives: [
    {
      letter: "C",
      type: "Fixed",
      label: "HDD",
      total_kb: 2090000,
      free_kb: 780000,
    },
    { letter: "D", type: "CDROM", label: "CDROM", total_kb: 0, free_kb: 0 },
  ],
};

const MOCK_PROCESSES = [
  { pid: 4, name: "KERNEL32.DLL", threads: 1, memory_kb: 512 },
  { pid: 8, name: "EXPLORER.EXE", threads: 4, memory_kb: 4096 },
  { pid: 12, name: "SYSTRAY.EXE", threads: 1, memory_kb: 512 },
  { pid: 16, name: "MPREXE.EXE", threads: 2, memory_kb: 1024 },
  { pid: 24, name: "RNAAPP.EXE", threads: 1, memory_kb: 256 },
  { pid: 100, name: "MSTASK.EXE", threads: 2, memory_kb: 1024 },
];

const MOCK_DIR = {
  path: "C:\\WINDOWS",
  entries: [
    { name: "SYSTEM", type: "dir", size: 0, modified: "1999-09-03 12:00:00" },
    { name: "SYSTEM32", type: "dir", size: 0, modified: "1999-09-03 12:00:00" },
    { name: "TEMP", type: "dir", size: 0, modified: "2001-04-01 09:15:00" },
    {
      name: "WIN.INI",
      type: "file",
      size: 2048,
      modified: "2001-03-15 08:32:11",
    },
    {
      name: "SYSTEM.INI",
      type: "file",
      size: 1024,
      modified: "1999-09-03 12:00:00",
    },
    {
      name: "BOOTLOG.TXT",
      type: "file",
      size: 8192,
      modified: "2001-04-01 08:00:02",
    },
  ],
};

const MOCK_WIN_INI = [
  "[windows]",
  "load=",
  "run=",
  "NullPort=None",
  "device=HP LaserJet 4L,HPPCL5E,LPT1:",
  "",
  "[Desktop]",
  "Wallpaper=C:\\WINDOWS\\Cloud.bmp",
  "TileWallpaper=0",
  "",
  "[fonts]",
  "",
  "[extensions]",
  "bmp=mspaint.exe ^.bmp",
  "txt=notepad.exe ^.txt",
  "",
  "[PrinterPorts]",
  "HP LaserJet 4L=HPPCL5E,LPT1:,15,45",
].join("\r\n");

const MOCK_BOOTLOG = [
  "Loading device IFSHLP.SYS",
  "Loading device C:\\WINDOWS\\SYSTEM\\IOSUB.SYS",
  "LoadFailed=C:\\WINDOWS\\SYSTEM\\CDFS.VXD",
  "Loading device C:\\WINDOWS\\SYSTEM\\VCDFSD.VXD",
  "Loading device C:\\WINDOWS\\HIMEM.SYS",
  "Loading device C:\\WINDOWS\\EMM386.EXE",
].join("\r\n");

// Map paths → mock content
const FILE_CONTENT_MAP = {
  "C:\\WINDOWS\\WIN.INI": MOCK_WIN_INI,
  "C:\\WINDOWS\\BOOTLOG.TXT": MOCK_BOOTLOG,
  "C:\\WIN98BOTTER\\PERMISSIONS.INI": [
    "[general]",
    "enabled=1",
    "[permissions]",
    "file_read=1",
    "file_write=0",
    "execute=0",
    "registry_read=1",
    "registry_write=0",
  ].join("\r\n"),
};

const ALL_TOOLS = [
  "get_system_info",
  "get_disk_info",
  "get_screen_resolution",
  "list_directory",
  "read_file",
  "write_file",
  "delete_file",
  "copy_file",
  "move_file",
  "file_exists",
  "get_file_info",
  "ini_read",
  "ini_write",
  "ini_read_section",
  "ini_delete_key",
  "ini_list_sections",
  "run_command",
  "write_and_run_bat",
  "run_async",
  "get_async_output",
  "kill_async",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "registry_read",
  "registry_write",
  "registry_delete",
  "registry_list_keys",
  "list_processes",
  "kill_process",
  "get_hardware_info",
  "read_com_port",
  "write_com_port",
  "get_display_info",
  "get_audio_info",
  "list_windows",
  "get_window_text",
  "send_message",
  "play_sound",
  "midi_out",
  "get_event_log",
];

// ── Dispatch table ─────────────────────────────────────────────────────────────
function dispatch(method, params, id) {
  console.log(`  [CALL] ${method}`, JSON.stringify(params || {}).slice(0, 120));

  switch (method) {
    case "initialize":
      return buildResult(id, {
        protocol_version: "1.0",
        server_info: { name: "Win98MCPAgent", version: "0.1.0" },
        system_info: SYSTEM_INFO,
        permissions: {
          file_read: true,
          file_write: false,
          registry_read: true,
          registry_write: false,
          execute: false,
          process_kill: false,
          hardware_io: false,
          serial: false,
          scheduler: false,
          system: true,
        },
      });

    case "tools/list":
      return buildResult(id, { tools: ALL_TOOLS });

    case "tools/call":
      return dispatchTool(params, id);

    case "heartbeat":
      // Relay sends heartbeat requests; respond immediately
      return buildResult(id, { ok: true });

    default:
      return buildError(id, -32601, `Method not found: ${method}`);
  }
}

function dispatchTool({ name, arguments: args }, id) {
  switch (name) {
    case "get_system_info":
      return buildResult(id, SYSTEM_INFO);

    case "get_disk_info":
      return buildResult(id, { drives: SYSTEM_INFO.drives });

    case "list_directory": {
      const dir = args && args.path ? args.path.toUpperCase() : "C:\\";
      return buildResult(id, { ...MOCK_DIR, path: dir });
    }

    case "file_exists": {
      const p = args && args.path ? args.path : "";
      return buildResult(id, {
        exists: Object.prototype.hasOwnProperty.call(FILE_CONTENT_MAP, p),
      });
    }

    case "get_file_info": {
      const p = args && args.path ? args.path : "";
      const content = FILE_CONTENT_MAP[p];
      return buildResult(id, {
        path: p,
        exists: !!content,
        size_bytes: content ? Buffer.byteLength(content, "utf8") : 0,
        attributes: "A",
        modified: "2001-04-01 09:00:00",
      });
    }

    case "read_file": {
      const p = args && args.path ? args.path : "";
      const offset = args && args.offset ? args.offset : 0;
      const length = args && args.length ? args.length : 65536;
      const content = FILE_CONTENT_MAP[p] || `[mock content for ${p}]`;
      const bytes = Buffer.from(content, "utf8");
      const chunk = bytes.slice(offset, offset + length);
      return buildResult(id, {
        path: p,
        offset: offset,
        length: chunk.length,
        total_size: bytes.length,
        data_b64: chunk.toString("base64"),
        eof: offset + chunk.length >= bytes.length,
      });
    }

    case "write_file": {
      const p = args && args.path ? args.path : "";
      console.log(
        `  [WRITE] ${p}  (${(args.data_b64 || "").length} b64 chars)`,
      );
      return buildResult(id, { success: true, path: p });
    }

    case "delete_file":
      return buildResult(id, { success: true });

    case "copy_file":
    case "move_file":
      return buildResult(id, { success: true });

    case "ini_read":
      return buildResult(id, { value: "mock_value" });

    case "ini_read_section":
      return buildResult(id, { keys: { key1: "val1", key2: "val2" } });

    case "ini_write":
      return buildResult(id, { success: true });

    case "ini_list_sections":
      return buildResult(id, {
        sections: ["windows", "Desktop", "fonts", "extensions"],
      });

    case "ini_delete_key":
      return buildResult(id, { success: true });

    case "run_command": {
      const cmd = args && args.command ? args.command : "";
      console.log(`  [CMD] ${cmd}`);
      return buildResult(id, {
        command: cmd,
        exit_code: 0,
        stdout: `Executed: ${cmd}\r\nCommand completed successfully.\r\n`,
        stderr: "",
        duration_ms: 42,
      });
    }

    case "write_and_run_bat": {
      const bat = args && args.bat_path ? args.bat_path : "C:\\TEMP\\RUN.BAT";
      const lines = args && args.content ? args.content : "";
      console.log(`  [BAT] ${bat}\n${lines.slice(0, 200)}`);
      return buildResult(id, {
        bat_path: bat,
        exit_code: 0,
        stdout: `Batch completed: ${bat}\r\n`,
        stderr: "",
      });
    }

    case "run_async": {
      const cmd = args && args.command ? args.command : "";
      console.log(`  [ASYNC] ${cmd}`);
      return buildResult(id, { job_id: "job_001", started: true });
    }

    case "get_async_output":
      return buildResult(id, {
        job_id: args && args.job_id ? args.job_id : "job_001",
        done: true,
        exit_code: 0,
        stdout: "Async job completed.\r\n",
        stderr: "",
      });

    case "kill_async":
      return buildResult(id, { success: true });

    case "schedule_task": {
      const taskName = args && args.name ? args.name : "MockTask";
      const time = args && args.time ? args.time : "08:00";
      const cmd = args && args.command ? args.command : "";
      console.log(`  [SCHEDULE] ${taskName} @ ${time} → ${cmd}`);
      return buildResult(id, { success: true, task_id: 1 });
    }

    case "list_scheduled_tasks":
      return buildResult(id, {
        tasks: [
          {
            id: 1,
            time: "08:00",
            command: "C:\\WIN98BOTTER\\CLEANUP.BAT",
            days: "M T W Th F Sa Su",
          },
        ],
      });

    case "delete_scheduled_task":
      return buildResult(id, { success: true });

    case "list_processes":
      return buildResult(id, { processes: MOCK_PROCESSES });

    case "kill_process":
      return buildResult(id, { success: true });

    case "registry_read":
      return buildResult(id, { value: "MockRegistryValue", type: "REG_SZ" });

    case "registry_write":
      return buildResult(id, { success: true });

    case "registry_delete":
      return buildResult(id, { success: true });

    case "registry_list_keys":
      return buildResult(id, {
        keys: ["MockKey1", "MockKey2", "MockKey3"],
        values: { DefaultValue: "SomeData" },
      });

    case "get_hardware_info":
      return buildResult(id, {
        cpu: SYSTEM_INFO.processor,
        ram_kb: SYSTEM_INFO.ram_total,
        display: "1024x768 16-bit",
        sound: "Soundblaster 16 (ISA)",
      });

    case "get_display_info":
      return buildResult(id, {
        width: 1024,
        height: 768,
        bpp: 16,
        refresh: 60,
      });

    case "get_audio_info":
      return buildResult(id, {
        device: "Soundblaster 16",
        sample_rates: "8000,11025,22050,44100",
      });

    case "read_com_port":
      return buildResult(id, {
        data_b64: Buffer.from("mock serial data").toString("base64"),
        bytes: 16,
      });

    case "write_com_port":
      return buildResult(id, {
        success: true,
        bytes_written:
          args && args.data_b64 ? (args.data_b64.length * 0.75) | 0 : 0,
      });

    case "list_windows":
      return buildResult(id, {
        windows: [
          {
            hwnd: "0x0001",
            title: "Program Manager",
            class: "Progman",
            visible: true,
          },
          {
            hwnd: "0x0002",
            title: "Windows Explorer",
            class: "ExploreWClass",
            visible: true,
          },
        ],
      });

    case "get_window_text":
      return buildResult(id, { text: "Mock Window Content" });

    case "send_message":
      return buildResult(id, { result: 0 });

    case "play_sound":
      return buildResult(id, { success: true });

    case "midi_out":
      return buildResult(id, { success: true });

    case "get_event_log":
      return buildResult(id, { entries: [], count: 0 });

    case "get_screen_resolution":
      return buildResult(id, { width: 1024, height: 768, bpp: 16 });

    default:
      console.log(`  [UNKNOWN TOOL] ${name}`);
      return buildError(id, -32601, `Unknown tool: ${name}`);
  }
}

// ── Connection logic ───────────────────────────────────────────────────────────
let heartbeatTimer = null;

function connect() {
  console.log(`[mock-win98] Connecting to relay at ${HOST}:${PORT}...`);

  const socket = new net.Socket();
  let reconnectScheduled = false;

  function scheduleReconnect() {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    clearInterval(heartbeatTimer);
    console.log("[mock-win98] Reconnecting in 5 s...");
    setTimeout(connect, 5000);
  }

  const reader = createReader((msg) => {
    if (!msg.id && msg.method) {
      // Incoming notification (e.g. heartbeat ping from relay to us)
      console.log(`[mock-win98] Notification: ${msg.method}`);
      return;
    }
    const response = dispatch(msg.method, msg.params, msg.id);
    socket.write(encode(response));
  });

  socket.on("data", (chunk) => reader(chunk));

  socket.on("connect", () => {
    console.log(
      "[mock-win98] Connected to relay — ready to receive tool calls",
    );

    // Start sending heartbeat notifications
    heartbeatTimer = setInterval(() => {
      const hb = buildNotification("heartbeat", {
        timestamp: new Date().toISOString(),
        cpu_pct: Math.floor(Math.random() * 30),
        ram_free: 64000 + Math.floor(Math.random() * 10000),
      });
      socket.write(encode(hb));
      console.log("[mock-win98] Heartbeat sent");
    }, HEARTBEAT_INTERVAL_MS);
  });

  socket.on("error", (err) => {
    console.error("[mock-win98] Socket error:", err.message);
    scheduleReconnect();
  });

  socket.on("close", () => {
    console.log("[mock-win98] Socket closed");
    scheduleReconnect();
  });

  socket.connect(PORT, HOST);
}

connect();
