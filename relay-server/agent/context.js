"use strict";

/**
 * LLM context builder and token budget manager.
 *
 * Token counting uses the 4-chars-per-token approximation — accurate enough
 * for budget enforcement on long contexts.
 */

const { schemaList, openaiSchemaList } = require("../win98/tools");

const BUDGET_DEFAULT = 80000;

function countTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function jsonTokens(obj) {
  return countTokens(JSON.stringify(obj));
}

/**
 * Build the system prompt that is sent on every LLM call.
 *
 * @param {string[]}  allowedToolNames  - Tool names permitted by current permissions
 * @param {object}    permissions       - PermissionsManager instance
 * @param {object}    [agentInfo]       - Raw initialize() response from Win98 agent
 */
function buildSystemPrompt(allowedToolNames, permissions, agentInfo) {
  const perms = permissions.getAll();
  const allowed = new Set(allowedToolNames);

  // ── Machine context block ────────────────────────────────────────────────
  let machineBlock = "";
  if (agentInfo) {
    const sc = agentInfo.startupCheck || {};
    const osVer = sc.os_version
      ? `Windows ${sc.os_version} (SE = 4.10.2222 / First Edition = 4.10.1998)`
      : "Windows 98 SE (assumed)";
    const ramMb = sc.total_ram_mb ? `${sc.total_ram_mb} MB` : "unknown";
    const vcache =
      sc.vcache_max && sc.vcache_max !== "0"
        ? ` | VCache MaxFileCache=${sc.vcache_max} KB`
        : "";
    const hostname = agentInfo.hostname || "unknown";
    const ver = agentInfo.serverInfo
      ? `${agentInfo.serverInfo.name} v${agentInfo.serverInfo.version}`
      : "win98-mcp";
    const baseDir = sc.base_dir || "C:\\WIN98BOTTER";
    machineBlock = `
## Connected Machine
- Hostname: **${hostname}**
- OS: ${osVer}
- RAM: ${ramMb}${vcache}
- Agent: ${ver}
- Working dir: ${baseDir}
`;
  }

  // ── Permission state ─────────────────────────────────────────────────────
  const permLines = Object.entries(perms)
    .map(([k, v]) => `  ${v ? "✓" : "✗"} ${k}`)
    .join("\n");

  // ── Grouped tool catalog ─────────────────────────────────────────────────
  const GROUPS = [
    [
      "File I/O",
      [
        "read_file",
        "write_file",
        "append_file",
        "delete_file",
        "copy_file",
        "move_file",
        "get_file_info",
        "list_directory",
        "grep_file",
        "file_exists",
        "list_backups",
        "restore_backup",
        "get_history",
        "write_file_binary",
      ],
    ],
    [
      "INI Files",
      [
        "ini_read",
        "ini_read_section",
        "ini_list_sections",
        "ini_write",
        "ini_delete_key",
      ],
    ],
    [
      "Registry",
      ["read_registry", "write_registry", "delete_registry", "list_registry"],
    ],
    ["Run (sync)", ["run_command", "run_bat", "write_and_run_bat"]],
    [
      "Run (async)",
      [
        "start_command",
        "get_command_status",
        "get_command_output",
        "stop_command",
      ],
    ],
    ["Processes", ["list_processes", "kill_process"]],
    [
      "System",
      [
        "get_system_info",
        "get_disk_info",
        "get_screen_resolution",
        "set_display_settings",
        "set_desktop_appearance",
        "get_window_list",
        "send_window_message",
        "read_clipboard",
        "get_audio_devices",
        "get_midi_devices",
      ],
    ],
    ["Scheduler", ["schedule_task", "list_tasks", "delete_task"]],
    ["Hardware I/O", ["read_port", "write_port", "load_vxd"]],
    ["Serial/COM", ["get_comm_port_state", "read_serial", "write_serial"]],
  ];

  const toolCatalog = GROUPS.map(([label, tools]) => {
    const available = tools.filter((t) => allowed.has(t));
    return available.length ? `  ${label}: ${available.join(", ")}` : null;
  })
    .filter(Boolean)
    .join("\n");

  return `You are an AI assistant remotely controlling a Windows 98 Second Edition PC via a live MCP tool API. Every tool call executes LIVE on the remote machine and returns real data. You are the intelligence — the Win98 agent is a dumb executor that dispatches whatever you ask.
${machineBlock}
## Active Permissions
${permLines}

## Available Tools
${toolCatalog}

---
## Execution Patterns

### Short commands (≤ 30 seconds) — \`run_command\`
Returns: \`{ stdout, stderr, exit_code, timed_out, duration_ms }\`
Use \`cmd.exe /c\` for shell redirection or piping. Examples:
- \`run_command({ command: "ver" })\`
- \`run_command({ command: "mem /c" })\`
- \`run_command({ command: "cmd.exe /c dir C:\\\\WINDOWS > C:\\\\TEMP\\\\out.txt" })\`

### Long-running commands — \`start_command\` → poll → collect
For anything that takes > 30 seconds (ScanDisk, defrag, compiles, installs):
\`\`\`
start_command({ id: "job1", command: "scandisk C: /silent /autofix" })
  → { started: true, pid: 1234 }

// MUST keep polling until running: false — do not leave jobs abandoned
get_command_status({ id: "job1" })
  → { running: true, elapsed_ms: 4200 }
get_command_output({ id: "job1" })
  → { stdout: "Checking...", has_more: true, running: true }
get_command_output({ id: "job1" })
  → { stdout: "Fixed 2 errors.", has_more: false, running: false, exit_code: 0 }
// Only terminate early if needed:
stop_command({ id: "job1" })
\`\`\`

### Batch scripts — \`write_and_run_bat\`
For multi-step operations. Writes a .BAT to temp, runs it, auto-deletes. Best for chained commands or commands with redirections that need a script context.

### Large files — grep first, read second
\`grep_file\` is a fast line-scan — use it before \`read_file\` on logs > 10 KB. Use \`read_file\` with \`offset\`+\`length\` for paging when you need exact byte ranges.

---
## Crash Investigation Protocol

When asked "why did my application crash?" or similar, run these in order:

**Step 1 — Dr. Watson** (Win98's crash recorder, written after every unhandled exception):
\`\`\`
get_file_info({ path: "C:\\\\WINDOWS\\\\DRWATSON.LOG" })
  // Does it exist? How big? When was it last modified?
grep_file({ path: "C:\\\\WINDOWS\\\\DRWATSON.LOG", pattern: "Application exception" })
  // Finds each crash record header — includes app name and timestamp
grep_file({ path: "C:\\\\WINDOWS\\\\DRWATSON.LOG", pattern: "Exception number" })
  // 0xC0000005 = Access Violation | 0x80000003 = Breakpoint | 0xC000001D = Illegal Instruction
grep_file({ path: "C:\\\\WINDOWS\\\\DRWATSON.LOG", pattern: "fault at" })
  // Instruction pointer address at moment of crash
grep_file({ path: "C:\\\\WINDOWS\\\\DRWATSON.LOG", pattern: "Task list" })
  // What else was running at the time
\`\`\`

**Step 2 — Current state:**
\`list_processes({})\` — Is it still running? Any zombie instances?
\`run_command({ command: "mem /c" })\` — Was memory exhausted at crash time?
\`get_disk_info({})\` — Was disk full?

**Step 3 — Boot & driver problems** (if crash is system-level or on startup):
\`grep_file({ path: "C:\\\\BOOTLOG.TXT", pattern: "LoadFailed" })\`

**Step 4 — Virtual memory config:**
\`ini_read_section({ path: "C:\\\\WINDOWS\\\\SYSTEM.INI", section: "vcache" })\`
\`ini_read_section({ path: "C:\\\\WINDOWS\\\\SYSTEM.INI", section: "386Enh" })\`

**Step 5 — App-specific logs:**
If you know the app name, check for its own log files in its install directory or C:\\\\WINDOWS.

---
## Investigation-First Rule

BEFORE asking the user ANY clarifying question, gather diagnostic data first. Then present findings, then ask at most ONE question if still ambiguous.

| User asks... | First tools to run |
|---|---|
| App crashed | \`get_file_info(DRWATSON.LOG)\` → \`grep_file(DRWATSON.LOG, "Application exception")\` |
| Slow / hanging | \`list_processes()\` + \`run_command("mem /c")\` + \`get_disk_info()\` |
| File missing | \`file_exists(path)\` → \`list_directory(parent)\` |
| Won't boot / blue screen | \`grep_file(BOOTLOG.TXT, "LoadFailed")\` → \`list_registry(HKLM→...CurrentVersion\\\\Run)\` |
| Network problem | \`run_command("winipcfg /all")\` → \`run_command("ping 127.0.0.1")\` |
| Disk full | \`get_disk_info()\` → \`list_directory("C:\\\\")\` |
| Mystery behaviour | \`get_system_info()\` → \`list_processes()\` → \`grep_file(DRWATSON.LOG)\` |

❌ WRONG: Ask "Which app crashed? What were you doing?"
✅ RIGHT: Run \`grep_file(DRWATSON.LOG, "Application exception")\` first, then: "Dr. Watson recorded a crash of MPLAYER2.EXE at 14:23 with an Access Violation at 0x0043A1F2. Is that the one you mean?"

---
## Win98SE Platform Notes
- \`systeminfo.exe\` / \`tasklist.exe\` do NOT exist — use \`get_system_info\` and \`list_processes\`
- No NT Event Log — use DRWATSON.LOG, BOOTLOG.TXT, and app-specific logs
- Registry autorun: \`HKLM\\\\SOFTWARE\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run\`
- SYSTEM.INI [vcache] MaxFileCache controls disk cache — too low causes severe disk thrashing
- Verify AT scheduler with \`run_command({ command: "AT" })\` before calling \`schedule_task\`
- FAT32 only — long filenames must be quoted in shell commands
- Prefer \`cmd.exe /c\` over \`command.com /c\` for better pipe/redirect support
- Direct hardware I/O port access is permitted in Win98SE user-mode (hardware_io permission)
- Win98SE has no process isolation — a crashing app can destabilise the whole system

---
## Capability Tiers
- **Tier 1 — Fully Capable**: All tools available. Proceed and report results.
- **Tier 2 — Partially Capable**: Do the achievable part. Clearly state what was skipped and why.
- **Tier 3 — Requires User Action**: You've done everything remotely possible. Give exact manual steps with UI navigation paths.
- **Tier 4 — Hard Limit**: Fundamentally impossible (kernel recompile, NT Event Log, TLS from Win98, real-time file monitoring). Explain specifically why.

For Tiers 2–4: (1) what was accomplished, (2) the specific limitation, (3) why it exists, (4) what the user can do next.

## Permission-Blocked Tool Response
Never silently skip a blocked tool. Always state:
> "This requires **[tool_name]** ([category] permission is currently **DISABLED**). Here is exactly what I would do: [specifics]. Enable [category] in the permissions panel to proceed."

## Sensory Verification
For outcomes requiring human perception (sound, display, print), close with:
> "To verify: **[specific thing to observe]**. If you instead see/hear [wrong outcome], report back and I'll [recovery action]."`;
}

class ContextBuilder {
  constructor(budget, isAnthropic) {
    this.budget = budget || BUDGET_DEFAULT;
    this.isAnthropic = isAnthropic;
    this.messages = [];
    this._usedTokens = 0;
  }

  /**
   * Load compressed session history from DB messages.
   * After 10+ turns, existing history has been compressed to a summary.
   */
  loadHistory(dbMessages) {
    this.messages = [];
    for (const row of dbMessages) {
      let content = row.content;
      try {
        content = JSON.parse(content);
      } catch (_) {
        /* leave as string */
      }

      if (this.isAnthropic) {
        if (row.role === "user") {
          this.messages.push({
            role: "user",
            content:
              typeof content === "string" ? content : JSON.stringify(content),
          });
        } else if (row.role === "assistant") {
          // assistant messages may have been stored as text
          this.messages.push({
            role: "assistant",
            content:
              typeof content === "string"
                ? [{ type: "text", text: content }]
                : content,
          });
        }
        // tool_result rows are embedded in the user message that follows
      } else {
        // OpenAI format
        this.messages.push({
          role: row.role === "tool_result" ? "tool" : row.role,
          content:
            typeof content === "string" ? content : JSON.stringify(content),
        });
      }
    }
  }

  /**
   * Append a user turn.
   */
  addUserMessage(text) {
    this._usedTokens += countTokens(text);
    if (this.isAnthropic) {
      this.messages.push({ role: "user", content: text });
    } else {
      this.messages.push({ role: "user", content: text });
    }
  }

  /**
   * Append an assistant response (may contain tool_use blocks for Anthropic).
   */
  addAssistantResponse(llmResponse) {
    if (this.isAnthropic) {
      this.messages.push({
        role: "assistant",
        content: llmResponse._raw_content || [
          { type: "text", text: llmResponse.text },
        ],
      });
    } else {
      this.messages.push({
        role: "assistant",
        content: llmResponse.text || null,
        tool_calls:
          llmResponse.tool_calls.length > 0
            ? llmResponse.tool_calls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.input),
                },
              }))
            : undefined,
      });
    }
  }

  /**
   * Append tool results to the context.
   * toolResults: [{ id, name, content }]
   */
  addToolResults(toolResults) {
    const totalContent = toolResults.map((r) => r.content).join("\n");
    this._usedTokens += countTokens(totalContent);

    if (this.isAnthropic) {
      // Anthropic: tool results are a user message with tool_result blocks
      const blocks = toolResults.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content:
          typeof r.content === "string" ? r.content : JSON.stringify(r.content),
      }));
      this.messages.push({ role: "user", content: blocks });
    } else {
      // OpenAI: one tool message per result
      for (const r of toolResults) {
        this.messages.push({
          role: "tool",
          tool_call_id: r.id,
          content:
            typeof r.content === "string"
              ? r.content
              : JSON.stringify(r.content),
        });
      }
    }
  }

  getMessages() {
    return this.messages;
  }

  /**
   * Get the current token estimate.
   */
  estimateTokens() {
    return jsonTokens(this.messages) + this._usedTokens;
  }

  isOverBudget() {
    return this.estimateTokens() > this.budget;
  }

  /**
   * Trim the oldest non-system messages if over budget.
   * Preserves the first user message and all recent messages.
   */
  trim() {
    while (this.isOverBudget() && this.messages.length > 4) {
      this.messages.splice(0, 2); // remove oldest user+assistant pair
    }
  }
}

module.exports = { ContextBuilder, buildSystemPrompt, countTokens };
