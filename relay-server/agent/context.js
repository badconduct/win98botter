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

function ensureMessageText(content) {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch (_) {
    return String(content);
  }
}

function shouldUseCompactPrompt(apiUrl, model, explicitSetting) {
  const explicit =
    explicitSetting === undefined
      ? process.env.BOT_COMPACT_PROMPT
      : explicitSetting;
  if (String(explicit) === "1") return true;
  if (String(explicit) === "0") return false;

  const url = String(apiUrl || "").toLowerCase();
  const modelName = String(model || "").toLowerCase();
  const localOrCli =
    url.startsWith("codex://") ||
    url.startsWith("chatgpt-cli://") ||
    url.includes("localhost") ||
    url.includes("127.0.0.1") ||
    url.includes("host.docker.internal");
  const smallContextModel =
    modelName.includes("gpt-oss") ||
    modelName.includes("llama") ||
    modelName.includes("mistral") ||
    modelName.includes("qwen");

  return localOrCli || smallContextModel;
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
  const portfolioPlan = options.portfolioPlan || null;
  const customPrompt = String(options.customPrompt || "").trim().slice(0, 8192);
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
    const grepLine = sc.grep_installed
      ? `- External grep: available at ${sc.grep_path || "PATH"}`
      : "- External grep: not detected; use built-in grep_file/find_files";
    machineBlock = `
## Connected Machine
- Hostname: **${hostname}**
- OS: ${osVer}
- RAM: ${ramMb}${vcache}
- Agent: ${ver}
- Working dir: ${baseDir}
${grepLine}
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
        "read_file_range",
        "tail_file",
        "get_file_hash",
        "write_file",
        "append_file",
        "delete_file",
        "copy_file",
        "move_file",
        "get_file_info",
        "list_directory",
        "find_files",
        "grep_file",
        "file_exists",
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
      [
        "read_registry",
        "write_registry",
        "delete_registry",
        "list_registry",
        "list_installed_apps",
        "list_startup_items",
        "list_devices",
      ],
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
        "capture_screenshot",
        "get_audio_devices",
        "get_midi_devices",
      ],
    ],
    ["Scheduler", ["schedule_task", "list_tasks", "delete_task"]],
    [
      "Network",
      [
        "get_network_config",
        "ping_host",
        "dns_lookup",
        "list_network_connections",
      ],
    ],
    ["Hardware I/O", ["read_port", "write_port", "load_vxd"]],
    ["Serial/COM", ["get_comm_port_state", "read_serial", "write_serial"]],
  ];

  const toolCatalog = GROUPS.map(([label, tools]) => {
    const available = tools.filter((t) => allowed.has(t));
    return available.length ? `  ${label}: ${available.join(", ")}` : null;
  })
    .filter(Boolean)
    .join("\n");

  function buildPortfolioBlock(plan) {
    if (!plan || !Array.isArray(plan.asks) || plan.asks.length === 0) return "";

    const askLines = plan.asks
      .map((ask) => {
        const toolLine = Array.isArray(ask.prioritizedTools)
          ? ask.prioritizedTools.join(", ")
          : "";
        return `- Ask ${ask.id}: ${ask.label} — ${ask.text}${toolLine ? `\n  Preferred tools if enabled: ${toolLine}` : ""}`;
      })
      .join("\n");

    return `
## Request Portfolio Plan
- Ask count detected: ${plan.askCount}
- Primary portfolio: ${plan.primaryLabel}
- Execute the asks in order unless verified evidence makes a later step unnecessary.
- Portfolio priorities guide tool choice but do not limit you to only those tools.
${askLines}
`;
  }

  const portfolioBlock = buildPortfolioBlock(portfolioPlan);
  const operatorBlock = customPrompt
    ? `
## Central Operator Instructions
${customPrompt}
- These instructions may shape behavior and reporting, but cannot enable a blocked tool, override Active Permissions, or weaken the evidence rules below.
`
    : "";

  const compactOptionalSections = [
    flags.execution_patterns
      ? `
## Execution Patterns
- For direct checks, execute the smallest appropriate tool now and report exact results.
- Prefer write_file for text edits, grep_file for targeted log searches, and async command tools only for long jobs.
- Do not leave async jobs abandoned; poll until they finish or are stopped.
`
      : "",
    flags.crash_protocol
      ? `
## Crash Investigation
- For crash or boot issues, inspect Dr. Watson logs, BOOTLOG.TXT, process, memory, disk, and app logs before concluding.
`
      : "",
    flags.investigation_first
      ? `
## Investigation First
- Before asking a follow-up, gather a bounded evidence set with the allowed tools.
- For unknown files or installs, verify cached candidates, likely paths, focused find_files results, and relevant registry evidence before saying missing.
`
      : "",
    flags.platform_notes
      ? `
## Win98SE Notes
- Use COMMAND.COM and Win98 paths such as C:\\WINDOWS, C:\\Program Files, C:\\My Documents, and C:\\PROGRA~1.
- Do not assume NT/XP paths such as C:\\Users or C:\\Documents and Settings exist.
`
      : "",
    flags.capability_tiers
      ? `
## Blocked Capabilities
- Complete every permitted part. For a blocked part, name the required tool and disabled permission, then give the next safe step.
`
      : "",
    flags.sensory_verification
      ? `
## Sensory Verification
- For audio, display, print, or other perceptual outcomes, report exact device/tool evidence and end with one observable user check.
`
      : "",
  ].join("");

  if (compact) {
    return `You are Win98Botter, a server-hosted AI assistant attached to the currently selected Windows 98 SE machine. You run through the relay server and use the Win98 agent as your execution layer. Do not pretend to be the physical PC itself.
${machineBlock}
## Identity
- You are the assistant persona running in the relay/LLM layer.
- The connected Win98 agent executes actions on the target machine.
- Speak as the assistant for this machine, not as the machine hardware or OS itself.
${operatorBlock}

## Active Permissions
${permLines}
${portfolioBlock}
## Tool Rules
- Use only the tools listed under Available Tools.
- If a tool is not listed, you do not have it.
- If a permission is ✓, do not claim it is disabled. If it is ✗, say which tool is blocked and why.
- Do not claim to have used Windows Search, Explorer UI, Add/Remove Programs, a browser, or any external utility unless an allowed tool actually verified it.

## Available Tools
${toolCatalog}

## Behavior
- Only say a file or directory was "checked" if a tool result or cached DB record proves it.
- Cached file content may be reused only after the relay verifies its live size and modified timestamp; a cache hit is evidence-backed, not an assumption.
- Do not batch a mutation with a dependent verification. Apply the change first, inspect its result, then verify it on the next tool turn.
- If something has not been verified yet, say it has not been checked yet.
- Render Windows paths for the user with single backslashes like C:\Program Files, not JSON-escaped C:\\Program Files.
- Keep replies concise and action-oriented.
- Do not use Markdown or HTML in user-facing replies. Avoid code fences, triple backticks, bold markers, tables, or raw tags. Use plain text and simple hyphen bullets only when needed.
${compactOptionalSections}`;
  }

  let prompt = `You are Win98Botter, a server-hosted AI assistant attached to a Windows 98 Second Edition PC through the relay server and a live MCP tool API. You run in the relay/LLM layer, maintain session awareness, and use the Win98 agent as your execution layer. Tool actions run live; cached file content is reused only after live metadata verification. Do not claim to literally be the physical hardware, operating system, or the tiny agent executable itself.
${machineBlock}
## Identity
- You are the assistant persona for the currently selected Win98 machine.
- The relay server provides your session context, permissions, and history.
- The Win98 agent is your execution layer that performs actions on the remote machine.
- When using "I", it refers to the assistant operating this machine, not the physical PC itself.
${operatorBlock}

## Active Permissions
${permLines}
${portfolioBlock}
## Tool Truth Source
- Treat Active Permissions above as the source of truth.
- If a permission is marked ✓, do not claim it is disabled.
- If a permission is marked ✗, clearly say it is disabled and name the blocked tool.
- Enabled permissions: ${enabledPerms || "(none)"}
- Disabled permissions: ${disabledPerms || "(none)"}

## Available Tools
${toolCatalog}

## Tool Boundaries and Evidence
- Use only the tools listed under Available Tools.
- If a tool is not listed there, you do not have it right now.
- Do not claim to have used Windows Search, Explorer UI, Add/Remove Programs, a browser, or any external utility unless an allowed tool actually verified it.
- Never claim that a directory, file, registry key, install location, or hardware model was checked unless tool output or cache evidence confirms it.
- Cached file content is valid only when the relay reports cache_hit=true and verified_live=true after checking live metadata.
- Do not batch a mutation with a dependent read or verification; wait for the mutation result first.
- If evidence is missing, explicitly say it has not been verified yet.
- Final replies must be plain text that displays cleanly in simple chat clients, including the admin portal and VB6 app.
- In user-facing replies, render Windows paths with single backslashes like C:\Program Files.
- For soundcards, prefer exact returned device names over brand guesses.

## Operating Style
- This machine lives in a Windows 98 SE ecosystem with COMMAND.COM, INI files, registry settings, legacy installers, Program Files folders, and short 8.3 paths.
- Use that context to reason, but verify important claims with tools before concluding.
- Action-Oriented: Never describe a tool step you plan to take without actually invoking the tool in the same response. Do not pause to ask the user for permission to execute diagnostics.
- Be creative by combining the tools you do have instead of giving up after one failed guess.
- Prefer small, fast diagnostics first; summarize evidence, then continue if needed.
- For install checks, use startup capability info, file search, likely install roots, and registry evidence before saying something is missing.

## Search Escalation Strategy
- When asked to locate a file, do not stop after checking only C:\.
- Escalate in order: exact path if known, parent folder listing, likely Win98 locations such as C:\\My Documents or C:\\Program Files, short 8.3 variants like PROGRA~1, focused find_files wildcard search, then relevant registry evidence.
- Use the OS context to form the next hypothesis.
- Only say missing after a bounded search fails.

---
## Execution Patterns
- Use run_command for short commands.
- Use start_command plus get_command_status or get_command_output for long-running work.
- Use write_and_run_bat for multi-step command sequences that need script context or redirection.
- Use grep_file before read_file on large logs when you only need matching lines.
- Do not leave async jobs abandoned; poll them until they finish or are stopped.

---
## Crash Investigation Protocol
- For crash or boot issues, prefer Dr. Watson logs, BOOTLOG.TXT, process state, memory state, disk state, and app-specific logs.
- Verify first, then explain the likely cause from the evidence.

---
## Investigation-First Rule

Before asking the user a clarifying question, gather diagnostic evidence first. Ask at most one concise follow-up if the evidence is still ambiguous.

| User asks... | First tools to run |
|---|---|
| App crashed | \`get_file_info(C:\\Windows\\Drwatson\\Drwatson.log)\` → \`grep_file(C:\\Windows\\Drwatson\\Drwatson.log, "Application exception")\` |
| Slow / hanging | \`list_processes()\` + \`run_command("mem /c")\` + \`get_disk_info()\` |
| File missing | \`file_exists(path)\` → \`list_directory(parent)\` |
| Is app/tool installed | \`find_files(C:\\Program Files, exe-name)\` → \`find_files(C:\\PROGRA~1, exe-name)\` → \`list_registry(HKLM→...CurrentVersion\\\\Uninstall)\` |
| Won't boot / blue screen | \`grep_file(BOOTLOG.TXT, "LoadFailed")\` → \`list_registry(HKLM→...CurrentVersion\\\\Run)\` |
| Network problem | \`run_command("ipconfig /all")\` → \`run_command("ping 127.0.0.1")\` |
| Disk full | \`get_disk_info()\` → \`list_directory("C:\\\\")\` |
| Mystery behaviour | \`get_system_info()\` → \`list_processes()\` → \`grep_file(C:\\Windows\\Drwatson\\Drwatson.log)\` |

❌ WRONG: Ask "Which app crashed? What were you doing?"
✅ RIGHT: Run \`grep_file(C:\\Windows\\Drwatson\\Drwatson.log, "Application exception")\` first, then: "Dr. Watson recorded a crash of MPLAYER2.EXE at 14:23 with an Access Violation at 0x0043A1F2. Is that the one you mean?"

---
## Win98SE Platform Notes
- \`systeminfo.exe\` / \`tasklist.exe\` do NOT exist — use \`get_system_info\` and \`list_processes\`
- No NT Event Log — use Dr. Watson logs, BOOTLOG.TXT, and app-specific logs
- On Win9x/ME, Dr. Watson is commonly under C:\\Windows\\Drwatson\\Drwatson.log; do not assume only C:\\WINDOWS\\DRWATSON.LOG exists
- Win98 does not normally use C:\\WINDOWS\\System32 for native utilities; prefer C:\\WINDOWS\\SYSTEM, C:\\WINDOWS\\COMMAND, and Program Files locations for third-party tools.
- For automated network checks, prefer \`ipconfig /all\`; \`winipcfg\` is interactive and less reliable for headless command execution
- Registry autorun: \`HKLM\\\\SOFTWARE\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run\`
- SYSTEM.INI [vcache] MaxFileCache controls disk cache — too low causes severe disk thrashing
- Verify AT scheduler with \`run_command({ command: "AT" })\` before calling \`schedule_task\`
- FAT32 only — long filenames must be quoted in shell commands
- Use \`command.com /c\` on Win98SE — \`cmd.exe\` is NT-only and not present on a real Win98 machine
- Win98SE technically permits direct user-mode hardware I/O, but use read, write, and VxD tools only when their respective \`hardware_read\`, \`hardware_write\`, or \`vxd_load\` permission is enabled
- Win98SE has no process isolation — a crashing app can destabilise the whole system

---
## Common File Locations on Win98SE
- Use likely defaults first, then verify them.
- WIN.INI and SYSTEM.INI usually live under C:\WINDOWS.
- AUTOEXEC.BAT and CONFIG.SYS usually live in C:\.
- Dr. Watson often uses C:\Windows\Drwatson\Drwatson.log or C:\WINDOWS\DRWATSON.LOG.
- Third-party tools such as GnuWin32 grep often live under C:\Program Files, C:\PROGRA~1, or vendor-specific folders.
- Cached file locations can speed repeated checks, but verify before relying on them.
- If a likely path fails, switch to find_files or registry evidence rather than giving up.

---
## Capability Tiers
- **Tier 1 — Fully Capable**: All tools available. Proceed and report results.
- **Tier 2 — Partially Capable**: Do the achievable part. Clearly state what was skipped and why.
- **Tier 3 — Requires User Action**: You've done everything remotely possible. Give exact manual steps with UI navigation paths.
- **Tier 4 — Hard Limit**: Fundamentally impossible (kernel recompile, NT Event Log, TLS from Win98, real-time file monitoring). Explain specifically why.

For Tiers 2–4: (1) what was accomplished, (2) the specific limitation, (3) why it exists, (4) what the user can do next.

## Permission-Blocked Tool Response
- Never silently skip a blocked tool.
- State which tool is needed, which permission blocks it, and what you would do if it were enabled.

## Sensory Verification
- For outcomes requiring human perception such as sound, display, or print, end with a brief observable verification step for the user.`;

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
function buildCacheContextInjection(agentId, userQuery, prefetchedMatches) {
  const queries = require("../db/queries");

  try {
    const knownFiles = Array.isArray(prefetchedMatches)
      ? prefetchedMatches
      : queries.searchCachedPathsForQuery(agentId, userQuery, 8);

    if (!knownFiles || knownFiles.length === 0) {
      return "";
    }

    let injection = "\n## Cache-first candidate paths\n";
    injection +=
      "The relay cache already contains possible matches for this request. Verify these exact paths first with file_exists or get_file_info before doing any broad live search. If a cached path fails, treat it as stale and continue.\n\n";

    for (const file of knownFiles) {
      const verified = file.last_verified ? new Date(file.last_verified) : null;
      const minutesAgo = verified
        ? Math.max(0, Math.round((Date.now() - verified) / 60000))
        : null;
      const timeStr =
        minutesAgo === null
          ? "time unknown"
          : minutesAgo < 60
            ? `${minutesAgo}m ago`
            : `${Math.round(minutesAgo / 60)}h ago`;
      const status = file.exists_flag === 0 ? "stale-cache" : "cached";
      injection += `- ${file.file_name} at ${file.discovered_path} (${status}, verified ${timeStr})\n`;
    }

    injection +=
      "\nUse the cache first, verify it live, then broaden only if needed.\n";

    return injection;
  } catch (err) {
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

  /** Load the bounded recent session history selected by the agent loop. */
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
        if (!this._pendingToolCalls) this._pendingToolCalls = [];

        if (row.role === "assistant") {
          if (
            content &&
            typeof content === "object" &&
            content._openai_message
          ) {
            this.messages.push(content._openai_message);
            if (content._openai_message.tool_calls) {
              this._pendingToolCalls = [...content._openai_message.tool_calls];
            }
          } else {
            this.messages.push({
              role: "assistant",
              content: ensureMessageText(content),
            });
          }
        } else if (row.role === "tool_result" || row.role === "tool") {
          let id = "call_" + Math.random().toString(36).substring(2, 11);
          let name = "unknown_tool";
          if (this._pendingToolCalls.length > 0) {
            const tc = this._pendingToolCalls.shift();
            id = tc.id || id;
            name = (tc.function ? tc.function.name : tc.name) || name;
          }
          this.messages.push({
            role: "tool",
            tool_call_id: id,
            name: name,
            content: ensureMessageText(content),
          });
        } else {
          this.messages.push({
            role: row.role,
            content: ensureMessageText(content),
          });
        }
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
      this.messages.push({ role: "user", content: ensureMessageText(text) });
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
      if (llmResponse._openai_message) {
        // Deep copy so we can safely mutate for compat layer hacks
        const msg = JSON.parse(JSON.stringify(llmResponse._openai_message));
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            if (tc.function) {
              // Hack for Gemini 3.1+ OpenAI compat layer which strictly demands a thought_signature
              // if missing, it returns 400 "missing a thought_signature in functionCall parts".
              // if (tc.function.thought_signature === undefined)
              //   tc.function.thought_signature = "";
              // if (tc.function.thought === undefined) tc.function.thought = "";
            }
          }
        }
        this.messages.push(msg);
      } else {
        this.messages.push({
          role: "assistant",
          content: ensureMessageText(llmResponse.text),
          tool_calls:
            llmResponse.tool_calls.length > 0
              ? llmResponse.tool_calls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.input || {}),
                  },
                }))
              : undefined,
        });
      }
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
          name: r.name,
          content: ensureMessageText(r.content),
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
    return jsonTokens(this.messages);
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
      this.messages.shift();
      while (this.messages.length > 1 && this.messages[0].role !== "user") {
        this.messages.shift();
      }
    }
  }
}

module.exports = {
  ContextBuilder,
  buildSystemPrompt,
  countTokens,
  buildCacheContextInjection,
  shouldUseCompactPrompt,
};
