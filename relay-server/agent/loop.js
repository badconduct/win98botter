"use strict";

/**
 * Agent orchestration loop.
 *
 * Pattern: plan → execute tools → reason → repeat until final answer.
 *
 * The loop is the intelligence of the relay. It:
 *  - Builds LLM context from session history and the user message
 *  - Calls the LLM and handles tool use responses
 *  - Intercepts read_file calls to run the staging/parsing pipeline
 *  - Enforces permissions before forwarding any tool call to Win98
 *  - Records tool calls and file changes in SQLite
 *  - Returns a final response string when the LLM stops calling tools
 */

const {
  ContextBuilder,
  buildSystemPrompt,
  buildCacheContextInjection,
} = require("./context");
const { schemaList, openaiSchemaList } = require("../win98/tools");
const queries = require("../db/queries");

const MAX_LOOP_ITERATIONS = 20;

const PERMISSION_PHRASES = {
  file_read: [
    "file_read",
    "file-system read",
    "filesystem read",
    "read the file system",
    "read file system",
  ],
  file_write: ["file_write", "file-system write", "filesystem write"],
  registry_read: ["registry_read", "registry read"],
  registry_write: ["registry_write", "registry write"],
  execute: ["execute", "execution permission"],
  process_kill: ["process_kill", "process kill"],
  hardware_io: ["hardware_io", "hardware io"],
  serial: ["serial"],
  scheduler: ["scheduler"],
  system: ["system permission", "system tools"],
};

class AgentLoop {
  constructor(
    llmClient,
    win98Client,
    stagingManager,
    permissions,
    logger,
    options,
  ) {
    this.llm = llmClient;
    this.win98 = win98Client;
    this.staging = stagingManager;
    this.perms = permissions;
    this.log = logger;
    this.options = options || {};
    this.phase1Store = this.options.phase1Store || null;
    this.selectedAgentId = this.options.selectedAgentId || null;
    this.promptFlags = this.options.promptFlags || null;
    this.loopTraceEnabled = process.env.BOT_LOOP_TRACE !== "0";
  }

  /**
   * Run the agent loop for a user message.
   *
   * @param {string} sessionId
   * @param {string} userMessage
   * @param {number} tokenBudget
   * @returns {{ response, tool_calls_made, llm_calls_made, tokens_used }}
   */
  async run(sessionId, userMessage, tokenBudget) {
    const isAnthropic = this.llm.isAnthropic();
    const historyWindow = this._getHistoryWindow();
    const effectiveBudget = this._getEffectiveTokenBudget(tokenBudget);

    // Build the allowed tool list (filtered by permissions)
    const allSchemas = schemaList();
    const allowedSchemas = this.perms.filterSchemas(allSchemas);
    const toolSchemas = isAnthropic
      ? allowedSchemas
      : openaiSchemaList(allowedSchemas.map((s) => s.name));

    const systemPrompt = buildSystemPrompt(
      allowedSchemas.map((s) => s.name),
      this.perms,
      this.win98.agentInfo,
      this.promptFlags,
      { compact: this._shouldUseCompactPrompt() },
    );

    // Load session history
    const historyRows = queries.getRecentMessages(sessionId, historyWindow);

    // Build context
    const ctx = new ContextBuilder(effectiveBudget, isAnthropic);
    ctx.loadHistory(historyRows);

    // Inject per-query cache information
    const agentId = this.selectedAgentId || this.win98.agentId;
    const cacheInjection = buildCacheContextInjection(agentId, userMessage);
    const userMessageWithCache = cacheInjection
      ? cacheInjection + "\n\n**Your request**: " + userMessage
      : userMessage;

    ctx.addUserMessage(userMessageWithCache);

    // Save user message to DB
    queries.saveMessage(sessionId, "user", userMessage);

    let llmCallCount = 0;
    let toolCallCount = 0;
    let totalTokens = 0;
    let finalResponse = "";
    let permissionRetryUsed = false;

    const maxIterations = this._getMaxLoopIterations();
    this._loopInfo(
      {
        sessionId,
        agentId: this.selectedAgentId || this.win98.agentId,
        historyWindow,
        effectiveBudget,
        maxIterations,
        model: this.llm.model,
      },
      "Agent loop started",
    );

    for (let iter = 0; iter < maxIterations; iter++) {
      if (ctx.isOverBudget()) ctx.trim();

      this._loopInfo(
        {
          sessionId,
          iteration: iter + 1,
          maxIterations,
          estimatedTokens: ctx.estimateTokens(),
        },
        "LLM turn started",
      );

      llmCallCount++;

      let llmResp;
      try {
        llmResp = await this.llm.call(
          ctx.getMessages(),
          toolSchemas,
          systemPrompt,
        );
      } catch (err) {
        this.log.error({ err }, "LLM call failed");
        finalResponse = `LLM error: ${err.message}`;
        break;
      }

      totalTokens += llmResp.usage.input_tokens + llmResp.usage.output_tokens;
      this._loopInfo(
        {
          sessionId,
          iteration: iter + 1,
          stopReason: llmResp.stop_reason,
          toolCalls: llmResp.tool_calls.length,
          inputTokens: llmResp.usage.input_tokens,
          outputTokens: llmResp.usage.output_tokens,
        },
        "LLM turn completed",
      );

      queries.updateSessionTokens(
        sessionId,
        llmResp.usage.input_tokens + llmResp.usage.output_tokens,
      );

      // Add the assistant response to context
      ctx.addAssistantResponse(llmResp);

      if (
        llmResp.stop_reason === "end_turn" ||
        llmResp.tool_calls.length === 0
      ) {
        const contradiction = this._getPermissionContradictions(llmResp.text);
        if (contradiction.length > 0 && !permissionRetryUsed) {
          permissionRetryUsed = true;
          this.log.warn(
            { contradiction, response: llmResp.text },
            "LLM claimed enabled permissions were disabled; forcing correction retry",
          );
          ctx.addUserMessage(
            this._buildPermissionCorrectionMessage(contradiction),
          );
          continue;
        }
        finalResponse = llmResp.text;
        if (!finalResponse || !String(finalResponse).trim()) {
          this.log.warn(
            {
              sessionId,
              iteration: iter + 1,
              stopReason: llmResp.stop_reason,
              usage: llmResp.usage,
            },
            "LLM returned empty final response",
          );
          finalResponse =
            "LLM returned an empty response. This usually means quota/rate limits, provider-side filtering, or a transient model failure. Please retry once, and check relay logs for the preceding LLM turn details.";
        }
        this._loopInfo(
          {
            sessionId,
            iteration: iter + 1,
            responseChars: finalResponse ? finalResponse.length : 0,
          },
          "Agent loop reached final response",
        );
        break;
      }

      // ── Execute tool calls ────────────────────────────────────────────────
      const toolResults = [];
      this._loopInfo(
        {
          sessionId,
          iteration: iter + 1,
          toolCallNames: llmResp.tool_calls.map((t) => t.name),
        },
        "Executing tool batch",
      );

      // Run independent tool calls in parallel
      const toolCallPromises = llmResp.tool_calls.map((tc) =>
        this._executeToolCall(tc, sessionId),
      );
      const results = await Promise.allSettled(toolCallPromises);

      for (let i = 0; i < llmResp.tool_calls.length; i++) {
        const tc = llmResp.tool_calls[i];
        const res = results[i];

        let content;
        if (res.status === "fulfilled") {
          content =
            typeof res.value === "string"
              ? res.value
              : JSON.stringify(res.value);
        } else {
          content = JSON.stringify({ error: res.reason.message });
        }

        toolResults.push({ id: tc.id, name: tc.name, content });
        toolCallCount++;
      }

      ctx.addToolResults(toolResults);
      this._loopInfo(
        {
          sessionId,
          iteration: iter + 1,
          toolResults: toolResults.length,
        },
        "Tool batch completed",
      );
    }

    // Save final assistant response
    queries.saveMessage(sessionId, "assistant", finalResponse);

    this._loopInfo(
      {
        sessionId,
        llmCallCount,
        toolCallCount,
        totalTokens,
        hasResponse: !!finalResponse,
      },
      "Agent loop ended",
    );

    return {
      response: finalResponse,
      tool_calls_made: toolCallCount,
      llm_calls_made: llmCallCount,
      tokens_used: totalTokens,
    };
  }

  /**
   * Execute a single tool call.
   * - Checks permissions
   * - Routes read_file through the staging pipeline
   * - Records call and results in DB
   */
  async _executeToolCall(tc, sessionId) {
    const { id, name, input } = tc;

    this.log.debug({ tool: name, args: input }, "Executing tool call");

    // Permission check
    if (!this.perms.isAllowed(name)) {
      const category = this.perms.categoryOf(name);
      return {
        permission_denied: true,
        tool: name,
        category,
        message: `Tool '${name}' is blocked (${category} permission is disabled). Enable it via the GUI to allow this action.`,
      };
    }

    // Check Win98 connectivity
    if (!this.win98.connected) {
      return { error: "Win98 agent is not connected. Cannot call tool." };
    }

    const startMs = Date.now();

    // ── Special handling: read_file → staging pipeline ────────────────────
    if (name === "read_file") {
      // The staging pipeline pulls, reassembles, and parses the file
      try {
        const staged = await this.staging.stageAndParse(sessionId, input.path);
        const durMs = Date.now() - startMs;
        queries.saveToolCall(
          sessionId,
          name,
          JSON.stringify(input),
          JSON.stringify(staged),
          durMs,
        );

        // ── Store file content in database cache ──────────────────────────
        const agentId = this.selectedAgentId || this.win98.agentId;
        if (agentId && staged && !staged.error) {
          try {
            const filePath = input.path;
            const fileName = filePath.split(/[\\\/]/).pop();

            // Get or record the file location
            queries.recordFileLocation(agentId, fileName, filePath);

            // Get the file_locations ID to use as FK for file_contents
            const db = require("../db/schema").getDb();
            const fileRecord = db
              .prepare(
                `SELECT id FROM file_locations 
               WHERE agent_id = ? AND file_name = ? AND discovered_path = ?
               ORDER BY id DESC LIMIT 1`,
              )
              .get(agentId, fileName, filePath);

            if (fileRecord && staged.content) {
              // Detect MIME type from extension
              const ext = fileName.split(".").pop().toLowerCase();
              const textExtensions = [
                "txt",
                "ini",
                "cfg",
                "bat",
                "com",
                "sys",
                "log",
                "asm",
                "c",
                "h",
                "cpp",
                "java",
                "py",
                "js",
              ];
              const isTextFile = textExtensions.includes(ext);

              // Store the content
              const contentBytes = Buffer.byteLength(staged.content, "utf8");
              queries.storeFileContent(
                fileRecord.id,
                null, // lineStart (null = first bytes/full file)
                null, // lineEnd
                staged.content,
                contentBytes,
              );

              // Update file metadata (MIME type, text flag, size)
              let mimeType = "application/octet-stream";
              if (isTextFile) mimeType = "text/plain";
              else if (ext === "jpg" || ext === "jpeg") mimeType = "image/jpeg";
              else if (ext === "png") mimeType = "image/png";

              queries.updateFileMetadata(
                fileRecord.id,
                mimeType,
                isTextFile ? 1 : 0,
                contentBytes,
              );

              this.log.debug(
                {
                  agentId,
                  fileName,
                  path: filePath,
                  bytes: contentBytes,
                  mimeType,
                },
                "Stored file content in cache",
              );
            }

            // Also record the directory tree entry
            queries.recordDirectoryTreeEntry(agentId, filePath, false);
          } catch (cacheErr) {
            this.log.warn(
              { error: cacheErr.message },
              "Failed to cache file content (will continue)",
            );
            // Don't throw — cache failure shouldn't break the read
          }
        }

        await this._capturePhase1FromToolResult(
          name,
          input,
          staged,
          sessionId,
          durMs,
        );
        return staged;
      } catch (err) {
        return { error: err.message };
      }
    }

    // ── All other tools: forward directly to Win98 ────────────────────────
    let result;
    try {
      result = await this.win98.callTool(name, input);
    } catch (err) {
      const durMs = Date.now() - startMs;
      queries.saveToolCall(
        sessionId,
        name,
        JSON.stringify(input),
        JSON.stringify({ error: err.message }),
        durMs,
      );
      return { error: err.message };
    }

    const durMs = Date.now() - startMs;
    queries.saveToolCall(
      sessionId,
      name,
      JSON.stringify(input),
      JSON.stringify(result),
      durMs,
    );

    // ── File location cache: record file_exists discoveries ────────────────
    if (
      name === "file_exists" &&
      input &&
      input.path &&
      result &&
      !result.error
    ) {
      const agentId = this.selectedAgentId || this.win98.agentId;
      const filePath = input.path;

      // Extract just the filename (e.g., "WIN.INI" from "C:\WINDOWS\WIN.INI")
      const fileName = filePath.split(/[\\\/]/).pop();

      if (fileName && agentId) {
        if (result.exists) {
          // File was found — record this location for future searches
          queries.recordFileLocation(agentId, fileName, filePath);
          // Also record the directory tree entry
          queries.recordDirectoryTreeEntry(agentId, filePath, false);
          this.log.debug(
            { agentId, fileName, path: filePath },
            "Recorded file location in cache",
          );
        } else {
          // File doesn't exist — mark all known locations as not found if this was a verification
          queries.updateFileLocationVerification(
            agentId,
            fileName,
            filePath,
            false,
          );
        }
      }
    }

    // ── File content caching: store read_file results ──────────────────────
    // Note: read_file has special handling above with staging pipeline
    // But we capture the result here for analysis
    if (
      name !== "read_file" &&
      name === "list_directory" &&
      result &&
      Array.isArray(result.entries)
    ) {
      // Record each discovered entry in the directory tree
      const agentId = this.selectedAgentId || this.win98.agentId;
      const dirPath = input.path;
      if (agentId && dirPath && result.entries) {
        for (const entry of result.entries) {
          const entryName = String(entry.name || "");
          const fullPath = /^[A-Za-z]:\\/.test(entryName)
            ? entryName
            : (dirPath.endsWith("\\") ? dirPath : dirPath + "\\") + entryName;
          const typeStr = String(entry.type || "").toUpperCase();
          const isDirectory =
            typeStr === "DIR" ||
            typeStr === "DIRECTORY" ||
            typeStr === "<DIR>" ||
            entry.is_dir === true;
          queries.recordDirectoryTreeEntry(agentId, fullPath, isDirectory);
        }
        this.log.debug(
          { agentId, path: dirPath, entryCount: result.entries.length },
          "Recorded directory tree entries",
        );
      }
    }

    await this._capturePhase1FromToolResult(
      name,
      input,
      result,
      sessionId,
      durMs,
    );

    // ── Record file changes for undo support ──────────────────────────────
    if (name === "write_file" || name === "ini_write") {
      queries.saveFileChange(
        sessionId,
        "write",
        input.path,
        result.backup_path || null,
        result.previous_value || null,
        input.content || input.value || null,
      );
    } else if (name === "delete_file") {
      // Mark file as deleted in cache
      const agentId = this.selectedAgentId || this.win98.agentId;
      const filePath = input.path;
      const fileName = filePath.split(/[\\\/]/).pop();
      if (agentId && fileName && result && !result.error) {
        queries.updateFileLocationVerification(
          agentId,
          fileName,
          filePath,
          false,
        );
        this.log.debug(
          { agentId, fileName, path: filePath },
          "Marked file as deleted in cache",
        );
      }

      queries.saveFileChange(
        sessionId,
        "delete",
        input.path,
        result.backup_path || null,
        null,
        null,
      );
    } else if (name === "write_registry") {
      queries.saveFileChange(
        sessionId,
        "registry_write",
        `${input.hive}\\${input.key}\\${input.value_name}`,
        null,
        null,
        input.data || null,
      );
    }

    return result;
  }

  async _capturePhase1FromToolResult(name, input, result, sessionId, durMs) {
    if (!this.phase1Store || !this.phase1Store.enabled) return;

    const agentId = this.selectedAgentId || this.win98.agentId;
    if (!agentId) return;

    try {
      if (
        name === "list_directory" &&
        result &&
        Array.isArray(result.entries)
      ) {
        const entries = result.entries.map((entry) => ({
          name: entry.name,
          entry_type: entry.type || "unknown",
          size_bytes: entry.size,
          modified_at: entry.modified,
        }));

        await this.phase1Store.upsertDirScan({
          agentId,
          dirPath: input.path,
          entries,
          scanDurationMs: durMs,
          sourceTool: "list_directory",
        });
      }

      if (name === "read_file") {
        const content = result
          ? JSON.stringify(result).slice(0, 1024 * 64)
          : null;
        await this.phase1Store.saveFileReadCapture({
          agentId,
          filePath: input.path,
          line_start: null,
          line_end: null,
          byte_start: input.offset || 0,
          byte_end:
            typeof input.offset === "number" && typeof input.length === "number"
              ? input.offset + input.length
              : null,
          is_partial: true,
          content,
          content_hash: null,
          source_tool: "read_file",
          session_id: sessionId,
          duration_ms: durMs,
        });
      }

      if (name === "list_registry" && result && result.values) {
        const values = Object.entries(result.values).map(
          ([value_name, value_data]) => ({
            value_name,
            value_type: null,
            value_data:
              typeof value_data === "string"
                ? value_data
                : JSON.stringify(value_data),
          }),
        );

        await this.phase1Store.upsertRegistryCapture({
          agentId,
          keyPath: `${input.hive}\\${input.key}`,
          values,
          sourceTool: "list_registry",
        });
      }

      if (name === "read_registry" && result) {
        await this.phase1Store.upsertRegistryCapture({
          agentId,
          keyPath: `${input.hive}\\${input.key}`,
          values: [
            {
              value_name: input.value_name || "(default)",
              value_type: result.type || null,
              value_data:
                result.data === undefined
                  ? null
                  : typeof result.data === "string"
                    ? result.data
                    : JSON.stringify(result.data),
            },
          ],
          sourceTool: "read_registry",
        });
      }
    } catch (err) {
      this.log.warn(
        { err: err.message, tool: name, agentId },
        "Phase 1 capture skipped due to cache error",
      );
    }
  }

  _getPermissionContradictions(text) {
    if (!text || typeof text !== "string") return [];

    const lower = text.toLowerCase();
    const mentionsDisabled =
      lower.includes("disabled") ||
      lower.includes("blocked") ||
      lower.includes("no permission") ||
      lower.includes("can't") ||
      lower.includes("cannot");
    if (!mentionsDisabled) return [];

    const perms = this.perms.getAll();
    const contradictions = [];

    for (const [perm, phrases] of Object.entries(PERMISSION_PHRASES)) {
      if (perms[perm] !== true) continue;
      if (phrases.some((p) => lower.includes(p))) {
        contradictions.push(perm);
      }
    }

    return contradictions;
  }

  _buildPermissionCorrectionMessage(contradictions) {
    const perms = this.perms.getAll();
    const enabled = Object.entries(perms)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ");

    return [
      "System correction: your previous reply incorrectly said permissions were disabled.",
      `Contradicted permissions: ${contradictions.join(", ")}.`,
      `Enabled permissions right now: ${enabled || "(none)"}.`,
      "Do not claim these are disabled. Continue by executing the requested checks with tools.",
    ].join(" ");
  }

  _shouldUseCompactPrompt() {
    const url = String(this.llm.apiUrl || "").toLowerCase();
    const model = String(this.llm.model || "").toLowerCase();

    if (process.env.BOT_COMPACT_PROMPT === "1") return true;
    if (process.env.BOT_COMPACT_PROMPT === "0") return false;

    const localUrl =
      url.includes("localhost") ||
      url.includes("127.0.0.1") ||
      url.includes("host.docker.internal");

    const smallContextModel =
      model.includes("gpt-oss") ||
      model.includes("llama") ||
      model.includes("mistral") ||
      model.includes("qwen");

    return localUrl || smallContextModel;
  }

  _getMaxLoopIterations() {
    const envVal = parseInt(process.env.BOT_MAX_LOOP_ITERATIONS || "", 10);
    if (!Number.isNaN(envVal) && envVal > 0) return envVal;

    const model = String(this.llm.model || "").toLowerCase();
    if (model.includes("gemini")) return 6;
    if (model.includes("grok") || model.includes("gpt-oss")) return 6;
    if (model.includes("gpt-oss") || model.includes("llama")) return 8;
    return MAX_LOOP_ITERATIONS;
  }

  _getHistoryWindow() {
    const envVal = parseInt(process.env.BOT_HISTORY_WINDOW || "", 10);
    if (!Number.isNaN(envVal) && envVal > 0) return envVal;

    const url = String(this.llm.apiUrl || "").toLowerCase();
    const model = String(this.llm.model || "").toLowerCase();
    if (url.includes("api.groq.com") || model.includes("grok")) return 10;
    if (model.includes("gemini")) return 12;
    if (model.includes("gpt-oss") || model.includes("llama")) return 14;
    return 30;
  }

  _getEffectiveTokenBudget(tokenBudget) {
    const configured = Number(tokenBudget) > 0 ? Number(tokenBudget) : 80000;

    const envVal = parseInt(process.env.BOT_CONTEXT_BUDGET || "", 10);
    if (!Number.isNaN(envVal) && envVal > 0) return envVal;

    const url = String(this.llm.apiUrl || "").toLowerCase();
    const model = String(this.llm.model || "").toLowerCase();

    if (url.includes("api.groq.com") || model.includes("grok")) {
      return Math.min(configured, 1800);
    }
    if (model.includes("gemini")) {
      return Math.min(configured, 2200);
    }
    if (model.includes("gpt-oss") || model.includes("llama")) {
      return Math.min(configured, 2600);
    }

    return configured;
  }

  _loopInfo(meta, msg) {
    if (!this.loopTraceEnabled) return;
    this.log.info(meta, msg);
  }
}

module.exports = AgentLoop;
