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
function buildSystemPrompt(
  allowedToolNames,
  permissions,
  agentInfo,
  promptFlags,
  promptOptions,
) {
  const perms = permissions.getAll();
  const allowed = new Set(allowedToolNames);
  const options = promptOptions || {};
  const compact = options.compact === true;
  const flags = {
    execution_patterns: true,
    crash_protocol: true,
    investigation_first: true,
    platform_notes: true,
    capability_tiers: true,
    sensory_verification: true,
    ...(promptFlags || {}),
  };

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
  const enabledPerms = Object.entries(perms)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");
  const disabledPerms = Object.entries(perms)
    .filter(([, v]) => !v)
    .map(([k]) => k)
    .join(", ");

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

  if (compact) {
    return `You are a Windows 98 SE remote operator. Use tools immediately for concrete checks; avoid generic help text.
${machineBlock}
## Active Permissions
${permLines}

## Permission Rules
- Active Permissions above are the source of truth.
- If a permission is ✓, do not claim it is disabled.
- If a permission is ✗, say which tool is blocked and why.

## Available Tools
${toolCatalog}

## Behavior
- For direct checks (file exists/read, registry lookup, process list, command run), execute tools now.
- Prefer minimal, fast diagnostics first; report exact results.
- If a path is unknown, check likely Win98 locations first, then ask one concise follow-up.
- Keep replies concise and action-oriented.`;
  }

  let prompt = `You are an AI assistant remotely controlling a Windows 98 Second Edition PC via a live MCP tool API. Every tool call executes LIVE on the remote machine and returns real data. You are the intelligence — the Win98 agent is a dumb executor that dispatches whatever you ask.
${machineBlock}
## Active Permissions
${permLines}

## Permission Truth Source (Must Follow)
- Treat **Active Permissions** above as the only source of truth.
- If a permission is marked **✓**, do NOT claim it is disabled.
- If a permission is marked **✗**, clearly say it is disabled and name the blocked tool.
- Before saying a tool is blocked, check the tool's permission category against Active Permissions.
- Enabled permissions: ${enabledPerms || "(none)"}
- Disabled permissions: ${disabledPerms || "(none)"}

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
## Common File Locations on Win98SE

When a user asks for a file by name alone (e.g., "read WIN.INI"), follow this **caching-aware strategy**:

### Step 0 — Check the Database Cache (fastest path)
The relay has a **file location cache** that records where files are found. Before searching:
- "WIN.INI was previously found at C:\\WINDOWS\\WIN.INI on 2026-04-13 14:23"  ← Trust this
- If cache exists: file_exists(cached_path) to verify it still exists
- If verified: use it immediately — no further search needed
- If not found: proceed to Step 1 (new search)

### Step 1 — Search Common Locations (if not in cache)
Standard Win98SE file locations, in order:

| File Name | Primary | Secondary | Fallback |
|---|---|---|---|
| WIN.INI | C:\\WINDOWS\\WIN.INI | C:\\WIN.INI | list_directory |
| SYSTEM.INI | C:\\WINDOWS\\SYSTEM.INI | C:\\WINDOWS\\SYSTEM | — |
| AUTOEXEC.BAT | C:\\AUTOEXEC.BAT | — | — |
| CONFIG.SYS | C:\\CONFIG.SYS | — | — |
| DRWATSON.LOG | C:\\WINDOWS\\DRWATSON.LOG | — | — |
| BOOTLOG.TXT | C:\\BOOTLOG.TXT | — | — |

When searching:
1. Test **one** likely location: file_exists(path)
2. If found: **record it in the cache**, recordFileLocation(file_name, path)
3. If not found: don't give up—try the next likely location
4. If exhausted all standard locations: use list_directory() to explore
5. Report **which path was found**, not just "found"

Mandatory fallback checks before declaring missing:
- For WIN.INI: check both C:\\WIN.INI and C:\\WINDOWS\\WIN.INI
- For SYSTEM.INI: check C:\\WINDOWS\\SYSTEM.INI
- For AUTOEXEC.BAT and CONFIG.SYS: check C:\\ root paths explicitly
- Never conclude "file missing" after a single failed file_exists call when a standard secondary path exists.

### Step 2 — Update Cache on Discovery
When you successfully find a file at a new location:
- Log it: "Found WIN.INI at C:\\WINDOWS\\WIN.INI"
- Cache behavior: Relay auto-records this for future requests
- Next query: Cache hit → instant verification

### Step 3 — Mark Files Not Found
If a thorough search for a file name has failed:
- "Searched C:\\WINDOWS\\, C:\\, parent dirs — WIN.INI does not exist on this agent"
- Relay records this negative result in cache
- Future requests: "Cache says this file does not exist, but let me verify..."

### Example: IDE.INF (rare file search)
Example sequence:
- User: "Do we have IDE.INF?"
- Step 0: Check cache → Cache miss (never searched before)
- Step 1: Try C:\\WINDOWS\\INF\\IDE.INF → Does not exist
- Step 1: Try C:\\WINDOWS\\IDE.INF → Does not exist
- Step 1: Try C:\\IDE.INF → Does not exist
- Step 1: Try list_directory to explore C:\\WINDOWS\\ → IDE.INF not found
- Step 2: Mark as not found in cache
- Step 3: Report: "IDE.INF does not exist on this machine. Checked C:\\WINDOWS\\, C:\\, and system directories."
- User: "Are you sure? Check again."
- Step 0: Check cache → Cache says not found (verified 2 mins ago)
- Step 1: Quick reverify: file_exists("C:\\WINDOWS\\IDE.INF") → still does not exist
- Step 3: Report: "Confirmed — IDE.INF is not present. Last verified 2 minutes ago."

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

  function stripSection(text, heading) {
    const start = text.indexOf(`## ${heading}`);
    if (start < 0) return text;
    const tail = text.slice(start + 1);
    const next = tail.indexOf("\n## ");
    if (next < 0) return text.slice(0, start).trim();
    return (text.slice(0, start) + tail.slice(next + 1)).trim();
  }

  if (!flags.execution_patterns) {
    prompt = stripSection(prompt, "Execution Patterns");
  }
  if (!flags.crash_protocol) {
    prompt = stripSection(prompt, "Crash Investigation Protocol");
  }
  if (!flags.investigation_first) {
    prompt = stripSection(prompt, "Investigation-First Rule");
  }
  if (!flags.platform_notes) {
    prompt = stripSection(prompt, "Win98SE Platform Notes");
  }
  if (!flags.capability_tiers) {
    prompt = stripSection(prompt, "Capability Tiers");
    prompt = stripSection(prompt, "Permission-Blocked Tool Response");
  }
  if (!flags.sensory_verification) {
    prompt = stripSection(prompt, "Sensory Verification");
  }

  return prompt;
}

/**
 * Build per-query cache injection for the LLM.
 *
 * Returns a formatted string that tells the LLM:
 * - What files we've already discovered
 * - Where they are located
 * - That it should verify even if cached
 *
 * This is injected before the user query to provide context.
 */
function buildCacheContextInjection(agentId, userQuery) {
  const queries = require("../db/queries");

  try {
    // Get known files that match the query context
    const knownFiles = queries.getKnownFilesForContextInjection(agentId, 10);

    if (!knownFiles || knownFiles.length === 0) {
      return ""; // No cache to inject
    }

    // Filter known files that might be relevant to the query
    const queryLower = (userQuery || "").toLowerCase();
    const relevantFiles = knownFiles.filter((f) => {
      const fileNameLower = (f.file_name || "").toLowerCase();
      return (
        queryLower.includes(fileNameLower) ||
        queryLower.includes("read") ||
        queryLower.includes("check") ||
        queryLower.includes("find")
      );
    });

    // If no relevant files, show a few of the most recent anyway
    const filesToShow =
      relevantFiles.length > 0 ? relevantFiles : knownFiles.slice(0, 5);

    if (filesToShow.length === 0) {
      return "";
    }

    // Format for the LLM
    let injection = "\n## Known File Locations (in cache)\n";
    injection +=
      "We have discovered these files before. I'll verify they still exist, then proceed:\n\n";

    for (const file of filesToShow) {
      const verified = new Date(file.last_verified);
      const minutesAgo = Math.round((Date.now() - verified) / 60000);
      const timeStr =
        minutesAgo < 60
          ? `${minutesAgo}m ago`
          : `${Math.round(minutesAgo / 60)}h ago`;
      injection += `- **${file.file_name}** at \`${file.discovered_path}\` (verified ${timeStr})\n`;
    }

    injection +=
      "\n**My approach**: Check if these files still exist, then read as requested.\n";

    return injection;
  } catch (err) {
    // Cache retrieval failed — don't break the query
    return "";
  }
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

module.exports = {
  ContextBuilder,
  buildSystemPrompt,
  countTokens,
  buildCacheContextInjection,
};
