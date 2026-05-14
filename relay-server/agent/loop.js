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
const { buildPortfolioPlan } = require("./portfolio");
const { schemaList, openaiSchemaList } = require("../win98/tools");
const queries = require("../db/queries");

const MAX_LOOP_ITERATIONS = 20;
const REMOTE_FILE_CHUNK_BYTES = 32768;
const MAX_SCREENSHOT_CACHE_BYTES = 8 * 1024 * 1024;

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
  screenshot: [
    "screenshot",
    "screenshot permission",
    "screenshot access",
    "visual capture",
  ],
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
    const allowedToolNames = allowedSchemas.map((s) => s.name);
    const toolSchemas = isAnthropic
      ? allowedSchemas
      : openaiSchemaList(allowedToolNames);

    const portfolioPlan = buildPortfolioPlan(userMessage, allowedToolNames);

    const systemPrompt = buildSystemPrompt(
      allowedToolNames,
      this.perms,
      this.win98.agentInfo,
      this.promptFlags,
      {
        compact: this._shouldUseCompactPrompt(),
        portfolioPlan,
      },
    );

    // Load session history
    const historyRows = queries.getRecentMessages(sessionId, historyWindow);

    // Build context
    const ctx = new ContextBuilder(effectiveBudget, isAnthropic);
    ctx.loadHistory(historyRows);

    // Inject per-query cache information
    const agentId = this.selectedAgentId || this.win98.agentId;
    const searchRequest = this._classifyAutosearchRequest(userMessage);
    const directShortcut = this._classifyDirectToolPrompt(userMessage);
    const cacheMatches = searchRequest.requiresSearch
      ? queries.searchCachedPathsForQuery(agentId, userMessage, 8)
      : [];
    const cacheInjection = buildCacheContextInjection(
      agentId,
      userMessage,
      cacheMatches,
    );
    const searchHint = this._buildSearchPreflightHint(
      searchRequest,
      allowedToolNames,
      cacheMatches,
    );
    const userParts = [];
    const portfolioHint = this._buildPortfolioExecutionHint(portfolioPlan);
    if (portfolioHint) userParts.push(portfolioHint);
    if (cacheInjection) userParts.push(cacheInjection);
    if (searchHint) userParts.push(searchHint);
    userParts.push("**Your request**: " + userMessage);

    // Save user message to DB
    queries.saveMessage(sessionId, "user", userMessage);

    let llmCallCount = 0;
    let toolCallCount = 0;
    let totalTokens = 0;
    let finalResponse = "";
    let permissionRetryUsed = false;
    let searchCorrectionCount = 0;
    const toolsUsed = new Set();

    if (directShortcut) {
      const shortcutResult = await this._runDirectToolShortcut(
        sessionId,
        directShortcut,
      );
      if (shortcutResult && shortcutResult.response) {
        finalResponse = this._sanitizeUserFacingResponse(
          shortcutResult.response,
        );
        queries.saveMessage(sessionId, "assistant", finalResponse);
        this._loopInfo(
          {
            sessionId,
            toolName: directShortcut.toolName,
            toolCallCount: shortcutResult.toolCalls || 0,
          },
          "Agent loop returned direct shortcut response",
        );
        return {
          response: finalResponse,
          tool_calls_made: shortcutResult.toolCalls || 0,
          llm_calls_made: 0,
          tokens_used: 0,
        };
      }
    }

    const preflightSummary = await this._preflightCacheCandidates(
      sessionId,
      cacheMatches,
      allowedToolNames,
      userMessage,
    );
    if (preflightSummary) {
      userParts.push(preflightSummary.note);
      toolCallCount += preflightSummary.toolCalls;
      for (const toolName of preflightSummary.toolsUsed) {
        toolsUsed.add(toolName);
      }

      const verifiedCacheResponse = this._buildVerifiedSearchResponse(
        userMessage,
        searchRequest,
        preflightSummary,
      );
      if (verifiedCacheResponse) {
        finalResponse = this._sanitizeUserFacingResponse(verifiedCacheResponse);
        queries.saveMessage(sessionId, "assistant", finalResponse);
        this._loopInfo(
          {
            sessionId,
            toolCallCount,
            verifiedPaths: preflightSummary.verifiedPaths || [],
          },
          "Agent loop returned verified cache response",
        );
        return {
          response: finalResponse,
          tool_calls_made: toolCallCount,
          llm_calls_made: 0,
          tokens_used: 0,
        };
      }
    }

    const userMessageWithCache = userParts.join("\n\n");

    ctx.addUserMessage(userMessageWithCache);

    const maxIterations = this._getMaxLoopIterations(searchRequest);
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

        if (
          searchRequest.requiresSearch &&
          !this._hasSufficientSearchEvidence(toolsUsed, cacheMatches)
        ) {
          searchCorrectionCount++;
          if (iter < maxIterations - 1) {
            this.log.warn(
              {
                sessionId,
                response: llmResp.text,
                toolsUsed: Array.from(toolsUsed),
                queryType: searchRequest.type,
                searchCorrectionCount,
              },
              "Search-style request answered without enough evidence; forcing tool-backed retry",
            );
            ctx.addUserMessage(
              this._buildSearchCorrectionMessage(
                searchRequest,
                allowedToolNames,
                cacheMatches,
              ),
            );
            continue;
          }
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
        toolsUsed.add(tc.name);
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

    if (!finalResponse || !String(finalResponse).trim()) {
      this.log.warn(
        { sessionId, llmCallCount, toolCallCount, maxIterations },
        "Agent loop ended without a final response; using fallback summary",
      );
      finalResponse =
        "I completed diagnostic steps but hit the current relay reasoning limit before writing a final summary. The checks did run. Please retry once for a concise summary, or narrow the request to a specific app, log, or symptom.";
    }

    finalResponse = this._sanitizeUserFacingResponse(finalResponse);

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
            const fallbackContent = JSON.stringify(staged.parsed || {}).slice(
              0,
              65536,
            );
            const cacheInfo = this._storeCachedFileSnapshot(
              agentId,
              input.path,
              {
                content:
                  typeof staged.content === "string" &&
                  staged.content.length > 0
                    ? staged.content
                    : fallbackContent,
                bytesStored:
                  staged.staged_bytes ||
                  Buffer.byteLength(
                    typeof staged.content === "string"
                      ? staged.content
                      : fallbackContent,
                    "utf8",
                  ),
                fileSizeBytes: staged.file_size || staged.staged_bytes || null,
                mimeType: staged.mime_type || this._mimeTypeForPath(input.path),
                isTextFile: staged.is_text !== false,
              },
            );

            this.log.debug(
              { agentId, path: input.path, cacheInfo },
              "Stored staged file content in cache",
            );
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

    if (
      name === "capture_screenshot" &&
      result &&
      !result.error &&
      result.path
    ) {
      try {
        const cacheInfo = await this._cacheCapturedScreenshot(result.path);
        result = { ...result, db_cache: cacheInfo };
      } catch (cacheErr) {
        this.log.warn(
          { error: cacheErr.message, path: result.path },
          "Failed to cache captured screenshot",
        );
        result = {
          ...result,
          db_cache: { cached: false, error: cacheErr.message },
        };
      }
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
        const isDirectory =
          result.is_directory === true || result.is_directory === 1;

        if (result.exists) {
          if (isDirectory) {
            queries.recordDirectoryTreeEntry(agentId, filePath, true, {
              exists: true,
            });
            this.log.debug(
              { agentId, path: filePath },
              "Verified directory existence in cache",
            );
          } else {
            // File was found — record this location for future searches
            queries.recordFileLocation(agentId, fileName, filePath);
            queries.recordDirectoryTreeEntry(agentId, filePath, false, {
              exists: true,
            });
            this.log.debug(
              { agentId, fileName, path: filePath },
              "Recorded file location in cache",
            );
          }
        } else {
          queries.updateDirectoryTreeVerification(agentId, filePath, false);

          const knownPath = queries.getFileLocationByPath(agentId, filePath);
          if (knownPath) {
            queries.updateFileLocationVerification(
              agentId,
              fileName,
              filePath,
              false,
            );
          }
        }
      }
    }

    // ── File content caching: store read_file results ──────────────────────
    // Note: read_file has special handling above with staging pipeline
    // But we capture the result here for analysis
    if (
      name !== "read_file" &&
      (name === "list_directory" || name === "find_files") &&
      result &&
      Array.isArray(result.entries)
    ) {
      const agentId = this.selectedAgentId || this.win98.agentId;
      const dirPath = input.path;
      const broadPattern =
        !input.pattern || input.pattern === "*" || input.pattern === "*.*";
      const pathExists =
        result.path_exists === true ||
        result.path_exists === 1 ||
        result.exists === true ||
        result.exists === 1;
      const isDirectory =
        result.is_directory === true || result.is_directory === 1;
      const verifiedDirExists =
        (pathExists && isDirectory) || result.entries.length > 0;

      if (agentId && dirPath) {
        queries.reconcileDirectoryListing(agentId, dirPath, result.entries, {
          authoritative:
            name === "list_directory" && broadPattern && !result.truncated,
          verifiedDirExists,
        });

        this.log.debug(
          {
            agentId,
            path: dirPath,
            entryCount: result.entries.length,
            tool: name,
            verifiedDirExists,
          },
          "Recorded verified directory tree entries",
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

  _mimeTypeForPath(filePath) {
    const ext = String(filePath || "")
      .split(".")
      .pop()
      .toLowerCase();

    switch (ext) {
      case "txt":
      case "ini":
      case "cfg":
      case "log":
      case "bat":
      case "cmd":
      case "reg":
      case "c":
      case "h":
      case "cpp":
      case "asm":
      case "js":
      case "json":
      case "md":
      case "xml":
      case "html":
      case "htm":
        return "text/plain";
      case "bmp":
        return "image/bmp";
      case "png":
        return "image/png";
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "gif":
        return "image/gif";
      default:
        return "application/octet-stream";
    }
  }

  _storeCachedFileSnapshot(agentId, filePath, snapshot) {
    if (!agentId || !filePath) return null;

    const fileName = String(filePath)
      .split(/[\\\/]/)
      .pop();
    if (!fileName) return null;

    queries.recordFileLocation(agentId, fileName, filePath);
    const fileRecord = queries.getFileLocationByPath(agentId, filePath);
    if (!fileRecord) return null;

    const content =
      typeof snapshot.content === "string" ? snapshot.content : "";
    const bytesStored =
      Number(snapshot.bytesStored) || Buffer.byteLength(content, "utf8");
    const fileSizeBytes = Number(snapshot.fileSizeBytes) || bytesStored || null;
    const mimeType = snapshot.mimeType || this._mimeTypeForPath(filePath);
    const isTextFile =
      snapshot.isTextFile !== undefined
        ? !!snapshot.isTextFile
        : mimeType.startsWith("text/");

    if (content) {
      queries.storeFileContent(fileRecord.id, null, null, content, bytesStored);
    }

    queries.updateFileMetadata(
      fileRecord.id,
      mimeType,
      isTextFile,
      fileSizeBytes,
    );
    queries.recordDirectoryTreeEntry(agentId, filePath, false);

    return {
      file_location_id: fileRecord.id,
      mime_type: mimeType,
      is_text_file: isTextFile,
      bytes_stored: bytesStored,
      file_size_bytes: fileSizeBytes,
    };
  }

  async _cacheCapturedScreenshot(filePath) {
    const agentId = this.selectedAgentId || this.win98.agentId;
    if (!agentId || !filePath) {
      return { cached: false, error: "missing_agent_or_path" };
    }

    const info = await this.win98.callTool("get_file_info", { path: filePath });
    if (!info || info.error) {
      return {
        cached: false,
        error: info && info.error ? info.error : "get_file_info_failed",
      };
    }
    if (!info.exists) {
      return { cached: false, error: "screenshot_not_found" };
    }

    const totalSize = Number(info.size_bytes ?? info.size ?? 0);
    const buffers = [];
    let offset = 0;
    let reachedEof = false;

    while (
      !reachedEof &&
      offset < totalSize &&
      offset < MAX_SCREENSHOT_CACHE_BYTES
    ) {
      const readResult = await this.win98.callTool("read_file", {
        path: filePath,
        offset,
        length: Math.min(
          REMOTE_FILE_CHUNK_BYTES,
          MAX_SCREENSHOT_CACHE_BYTES - offset,
        ),
      });

      if (!readResult || readResult.error) {
        throw new Error(
          readResult && readResult.error
            ? readResult.error
            : "read_file_failed",
        );
      }

      const chunkBuffer =
        typeof readResult.data_b64 === "string"
          ? Buffer.from(readResult.data_b64, "base64")
          : Buffer.from(readResult.content || "", "utf8");

      if (chunkBuffer.length === 0) break;
      buffers.push(chunkBuffer);

      const bytesRead = Number(
        readResult.bytes_read ?? readResult.length ?? chunkBuffer.length,
      );
      offset += bytesRead > 0 ? bytesRead : chunkBuffer.length;
      reachedEof = readResult.eof === true || readResult.eof === 1;
    }

    const screenshotBuffer = Buffer.concat(buffers);
    const cacheInfo = this._storeCachedFileSnapshot(agentId, filePath, {
      content: screenshotBuffer.toString("base64"),
      bytesStored: screenshotBuffer.length,
      fileSizeBytes: totalSize || screenshotBuffer.length,
      mimeType: "image/bmp",
      isTextFile: false,
    });

    return {
      cached: !!cacheInfo,
      truncated:
        totalSize > screenshotBuffer.length ||
        screenshotBuffer.length >= MAX_SCREENSHOT_CACHE_BYTES,
      ...cacheInfo,
    };
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

  async _runDirectToolShortcut(sessionId, shortcut) {
    if (!shortcut || !shortcut.toolName) return null;

    if (shortcut.kind === "grep") {
      return this._runGrepShortcut(sessionId, shortcut);
    }

    if (shortcut.kind === "disk") {
      return this._runDiskShortcut(sessionId, shortcut);
    }

    const result = await this._executeToolCall(
      {
        id: `direct-${shortcut.kind || shortcut.toolName}`,
        name: shortcut.toolName,
        input: shortcut.input || {},
      },
      sessionId,
    );

    return {
      response: this._formatDirectToolResponse(shortcut, result),
      toolCalls: 1,
    };
  }

  async _runGrepShortcut(sessionId, shortcut) {
    const sc =
      this.win98 && this.win98.agentInfo
        ? this.win98.agentInfo.startupCheck || {}
        : {};
    const candidates = [
      sc.grep_path,
      "C:\\Program Files\\GnuWin32\\bin\\grep.exe",
      "C:\\PROGRA~1\\GnuWin32\\bin\\grep.exe",
    ].filter(Boolean);

    let toolCalls = 0;
    const seen = new Set();

    for (const path of candidates) {
      const key = String(path).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const result = await this._executeToolCall(
        {
          id: `direct-grep-${toolCalls + 1}`,
          name: "file_exists",
          input: { path },
        },
        sessionId,
      );
      toolCalls++;

      if (result && result.exists) {
        return {
          response: `Yes. It is installed at ${path}.`,
          toolCalls,
        };
      }
    }

    if (sc.grep_installed && sc.grep_path) {
      return {
        response: `Yes. It appears to be installed at ${sc.grep_path}.`,
        toolCalls,
      };
    }

    return {
      response:
        "I could not verify a grep.exe installation path on this machine.",
      toolCalls,
    };
  }

  async _runDiskShortcut(sessionId, shortcut) {
    const drive = String(shortcut.input?.drive || "C:\\");
    let toolCalls = 0;

    const dirFallback = await this._tryDiskFreeFromDir(sessionId, drive);
    toolCalls += dirFallback.toolCalls || 0;
    if (Number.isFinite(dirFallback.freeBytes)) {
      return {
        response: `${drive.replace(/\\+$/, "").toUpperCase()} has about ${this._formatByteCount(dirFallback.freeBytes)} free.`,
        toolCalls,
      };
    }

    const result = await this._executeToolCall(
      {
        id: `direct-${shortcut.kind || shortcut.toolName}`,
        name: shortcut.toolName,
        input: shortcut.input || {},
      },
      sessionId,
    );
    toolCalls++;

    return {
      response: this._formatDirectToolResponse(shortcut, result),
      toolCalls,
    };
  }

  async _tryDiskFreeFromDir(sessionId, drive) {
    const driveRoot = String(drive || "C:\\").replace(/\\*$/, "\\");
    const driveLetter = /^[A-Z]:/i.test(driveRoot)
      ? driveRoot[0].toUpperCase()
      : "C";

    let content = "";
    let toolCalls = 0;

    if (this.perms.isAllowed("write_and_run_bat")) {
      const batResult = await this._executeToolCall(
        {
          id: `disk-bat-${driveLetter}`,
          name: "write_and_run_bat",
          input: {
            cwd: "C:\\WIN98BOTTER",
            content: `@echo off\r\ndir ${driveRoot}\r\n`,
            timeout_ms: 15000,
          },
        },
        sessionId,
      );
      toolCalls++;

      if (batResult && !batResult.error && !batResult.permission_denied) {
        content = `${batResult.stdout || ""}\n${batResult.stderr || ""}`;
      }
    }

    if (!content && this.perms.isAllowed("run_command")) {
      const cmdResult = await this._executeToolCall(
        {
          id: `disk-dir-${driveLetter}`,
          name: "run_command",
          input: {
            command: `command.com /c dir ${driveRoot}`,
            cwd: "C:\\WIN98BOTTER",
            timeout_ms: 15000,
          },
        },
        sessionId,
      );
      toolCalls++;

      if (cmdResult && !cmdResult.error && !cmdResult.permission_denied) {
        content = `${cmdResult.stdout || ""}\n${cmdResult.stderr || ""}`;
      }
    }

    const match = String(content).match(/([\d,\.]+)\s+bytes free/i);
    if (!match) {
      return { toolCalls, freeBytes: null };
    }

    const numeric = Number(String(match[1]).replace(/[^\d]/g, ""));
    return {
      toolCalls,
      freeBytes: Number.isFinite(numeric) ? numeric : null,
    };
  }

  _looksLegacyCappedDiskResult(result) {
    const totalMb = Number(result?.total_mb);
    const freeMb = Number(result?.free_mb);
    const usedMb = Number(result?.used_mb);
    if (!Number.isFinite(totalMb) || !Number.isFinite(freeMb)) return false;
    return (
      totalMb <= 2300 &&
      freeMb >= totalMb * 0.95 &&
      (!Number.isFinite(usedMb) || usedMb <= 1)
    );
  }

  _formatByteCount(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return "unknown";
    const gb = value / (1024 * 1024 * 1024);
    const mb = value / (1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
    return `${Math.round(mb)} MB`;
  }

  _formatDirectToolResponse(shortcut, result) {
    if (!shortcut) return "";
    if (!result) {
      return "I could not retrieve that information just now.";
    }
    if (result.permission_denied) {
      return result.message || "That tool is currently blocked by permissions.";
    }
    if (result.error) {
      return `I couldn't retrieve that information: ${result.error}.`;
    }

    const collectNames = (items) =>
      Array.isArray(items)
        ? items
            .map((entry) =>
              entry && typeof entry.name === "string" ? entry.name.trim() : "",
            )
            .filter(Boolean)
        : [];

    if (shortcut.kind === "disk") {
      const drive = String(result.drive || shortcut.input.drive || "C:\\")
        .replace(/\\+$/, "")
        .toUpperCase();
      const freeMb = Number(result.free_mb);
      const totalMb = Number(result.total_mb);
      if (this._looksLegacyCappedDiskResult(result)) {
        return `${drive} is being reported through a legacy Win98 disk API that is capping the volume at about 2 GB, so that number is not trustworthy on this machine.`;
      }
      if (Number.isFinite(freeMb) && Number.isFinite(totalMb)) {
        const freeText = this._formatByteCount(freeMb * 1024 * 1024);
        const totalText = this._formatByteCount(totalMb * 1024 * 1024);
        return `${drive} has about ${freeText} free out of ${totalText} total.`;
      }
      if (Number.isFinite(freeMb)) {
        const freeText = this._formatByteCount(freeMb * 1024 * 1024);
        return `${drive} reports about ${freeText} free.`;
      }
      return `I checked ${drive}, but the free-space values were not available in the reply.`;
    }

    if (shortcut.kind === "clipboard") {
      const text = typeof result.text === "string" ? result.text.trim() : "";
      return text || "Clipboard is empty.";
    }

    if (shortcut.kind === "audio") {
      const inputNames = collectNames(result.input_devices);
      const outputNames = collectNames(result.output_devices);
      if (!inputNames.length && !outputNames.length) {
        return "No audio devices were reported.";
      }
      const parts = [];
      if (inputNames.length)
        parts.push(`Audio input: ${inputNames.join("; ")}`);
      if (outputNames.length)
        parts.push(`Audio output: ${outputNames.join("; ")}`);
      return parts.join("\n");
    }

    if (shortcut.kind === "midi") {
      const inputNames = collectNames(result.midi_input_devices);
      const outputNames = collectNames(result.midi_output_devices);
      if (!inputNames.length && !outputNames.length) {
        return "No MIDI devices were reported.";
      }
      const parts = [];
      if (inputNames.length) parts.push(`MIDI input: ${inputNames.join("; ")}`);
      if (outputNames.length)
        parts.push(`MIDI output: ${outputNames.join("; ")}`);
      return parts.join("\n");
    }

    return "I retrieved the requested information.";
  }

  _classifyDirectToolPrompt(userMessage) {
    const text = String(userMessage || "").trim();
    const lower = text.toLowerCase();
    if (!lower) return null;

    const driveMatch = lower.match(/\b([a-z]):\b/i);
    const drive = driveMatch ? `${driveMatch[1].toUpperCase()}:\\` : "C:\\";
    const asksForNames = /\b(name|names|only|just|exact)\b/i.test(lower);

    if (
      /\bmidi\b/i.test(lower) &&
      /\b(device|devices|name|names|installed|list|input|output)\b/i.test(lower)
    ) {
      return {
        kind: "midi",
        toolName: "get_midi_devices",
        input: {},
        asksForNames,
      };
    }

    if (
      !/\bmidi\b/i.test(lower) &&
      /\b(audio|sound|wave)\b/i.test(lower) &&
      /\b(device|devices|name|names|installed|list|input|output)\b/i.test(lower)
    ) {
      return {
        kind: "audio",
        toolName: "get_audio_devices",
        input: {},
        asksForNames,
      };
    }

    if (
      /\bclipboard\b/i.test(lower) &&
      /\b(read|show|tell|what|contents?|text|current)\b/i.test(lower)
    ) {
      return {
        kind: "clipboard",
        toolName: "read_clipboard",
        input: {},
        asksForNames,
      };
    }

    if (
      /\bgrep\b/i.test(lower) &&
      /\b(installed|where|path|present)\b/i.test(lower)
    ) {
      return {
        kind: "grep",
        toolName: "file_exists",
        input: {},
        asksForNames,
      };
    }

    if (
      /\b(free space|disk space|drive space|available space|space available|storage|drive size|disk size)\b/i.test(
        lower,
      ) ||
      (/\bhow much\b/i.test(lower) &&
        /\b(disk|space|free|storage)\b/i.test(lower)) ||
      (/\b(39gb|gb|gigabytes?)\b/i.test(lower) &&
        /\b(storage|disk|drive|free)\b/i.test(lower))
    ) {
      return {
        kind: "disk",
        toolName: "get_disk_info",
        input: { drive },
        asksForNames,
      };
    }

    return null;
  }

  _classifyAutosearchRequest(userMessage) {
    const text = String(userMessage || "").toLowerCase();
    if (!text) return { requiresSearch: false, type: null };

    const mentionsFileOrApp =
      /\b(files?|folders?|directories?|documents?|pdfs?|app|apps|application|applications|tool|tools|exe|dll|ini|logs?|bat|sys|drv|permissions?)\b/i.test(
        text,
      ) || /[a-z0-9_-]+\.[a-z0-9]+/i.test(text);

    const installIntent =
      /\b(do we have|is .* installed|check if .* installed)\b/i.test(text);

    const explicitLocationIntent =
      /\b(where is|where are|located|location of|path to|what is the path|locate|search for|look for)\b/i.test(
        text,
      ) ||
      installIntent ||
      (/\bfind\b/i.test(text) && mentionsFileOrApp);

    const discoveryIntent =
      /\b(are there any|do we have any|show me any|list any|what .* files|which .* files|any .* pdfs?)\b/i.test(
        text,
      ) && mentionsFileOrApp;

    const editIntent =
      /\b(edit|modify|change|update|patch|rewrite|write|append|delete|remove|rename|move)\b/i.test(
        text,
      );

    const diagnosticIntent =
      /\b(crash|crashed|why did|why does|error|bug|broken|hang|hanging|freeze|frozen|slow|not work|won't start|cannot start)\b/i.test(
        text,
      );

    if (
      (explicitLocationIntent || discoveryIntent) &&
      (mentionsFileOrApp || installIntent) &&
      !editIntent
    ) {
      return {
        requiresSearch: true,
        type: explicitLocationIntent ? "locate-path" : "discover-files",
      };
    }

    if (diagnosticIntent && !explicitLocationIntent) {
      return { requiresSearch: false, type: null };
    }

    return { requiresSearch: false, type: null };
  }

  _buildSearchPreflightHint(searchRequest, allowedToolNames, cacheMatches) {
    if (!searchRequest || !searchRequest.requiresSearch) return "";

    const available = new Set(allowedToolNames || []);
    const steps = [];
    if (available.has("file_exists"))
      steps.push("check the obvious or cached path");
    if (available.has("list_directory"))
      steps.push("inspect likely parent folders");
    if (available.has("find_files"))
      steps.push("run a focused wildcard search");
    if (available.has("list_registry") || available.has("read_registry")) {
      steps.push("inspect registry evidence for installed apps");
    }

    const hasCacheMatches =
      Array.isArray(cacheMatches) && cacheMatches.length > 0;

    return [
      "System workflow for this request type: the user is asking you to locate a file, folder, or installed tool.",
      hasCacheMatches
        ? "The relay cache already has likely candidate paths. Verify those exact cached paths first before any broad live search."
        : "Before giving a final answer, perform a bounded search without asking the user for more input first.",
      `Search order: ${steps.join(", ") || "use the best available file and registry tools"}.`,
      "Use Win98-aware locations such as C:\\WINDOWS, C:\\Program Files, C:\\My Documents, and short-path variants like C:\\PROGRA~1 when relevant.",
      "Do not assume NT/XP-style folders such as C:\\Users or C:\\Documents and Settings exist on Win98 unless a tool confirms them.",
      "If the request is about a topic such as Java PDFs, do not rely only on the topic word being in the filename. Broaden to the file type and likely document folders before concluding absent.",
      "Only say the item is missing after the bounded search fails.",
    ].join(" ");
  }

  _hasSufficientSearchEvidence(toolsUsed, cacheMatches) {
    const used = toolsUsed instanceof Set ? toolsUsed : new Set();
    const hasCacheMatches =
      Array.isArray(cacheMatches) && cacheMatches.length > 0;

    if (
      hasCacheMatches &&
      !used.has("file_exists") &&
      !used.has("get_file_info")
    ) {
      return false;
    }

    let score = 0;
    const weightedTools = [
      "find_files",
      "file_exists",
      "list_directory",
      "read_file",
      "get_file_info",
      "list_registry",
      "read_registry",
      "grep_file",
    ];

    for (const name of weightedTools) {
      if (used.has(name)) score++;
    }

    return score >= 2;
  }

  async _preflightCacheCandidates(
    sessionId,
    cacheMatches,
    allowedToolNames,
    userMessage,
  ) {
    const available = new Set(allowedToolNames || []);
    if (!Array.isArray(cacheMatches) || cacheMatches.length === 0) return null;
    if (!available.has("file_exists")) return null;

    const verified = [];
    const missing = [];
    const toolsUsed = new Set();
    let toolCalls = 0;
    const seen = new Set();

    const rankedPaths = this._rankPathsForQuery(
      userMessage,
      cacheMatches.map((match) => String(match.discovered_path || "")),
    );

    for (const path of rankedPaths.slice(0, 8)) {
      if (!path || seen.has(path.toLowerCase())) continue;
      seen.add(path.toLowerCase());

      const result = await this._executeToolCall(
        {
          id: `cache-preflight-${toolCalls + 1}`,
          name: "file_exists",
          input: { path },
        },
        sessionId,
      );

      toolCalls++;
      toolsUsed.add("file_exists");

      if (result && result.exists) verified.push(path);
      else missing.push(path);
    }

    if (verified.length === 0 && missing.length === 0) return null;

    const noteParts = [
      "Relay cache preflight already ran before the live search.",
    ];
    if (verified.length > 0) {
      noteParts.push(`Confirmed cached paths: ${verified.join("; ")}.`);
    }
    if (missing.length > 0) {
      noteParts.push(`Cached paths now missing: ${missing.join("; ")}.`);
    }
    noteParts.push(
      "Use the confirmed cache hits first. Only broaden to list_directory or find_files if needed.",
    );

    return {
      toolCalls,
      toolsUsed: Array.from(toolsUsed),
      verifiedPaths: verified,
      missingPaths: missing,
      note: noteParts.join(" "),
    };
  }

  _buildVerifiedSearchResponse(userMessage, searchRequest, preflightSummary) {
    if (!searchRequest || !searchRequest.requiresSearch) return "";

    const verifiedPaths = Array.isArray(preflightSummary?.verifiedPaths)
      ? preflightSummary.verifiedPaths
      : [];
    if (verifiedPaths.length === 0) return "";

    const scored = this._scorePathsForQuery(userMessage, verifiedPaths);
    const topScore = scored.length > 0 ? scored[0].score : 0;
    if (topScore <= 0) return "";

    const topPaths = scored
      .filter((item) => item.score === topScore)
      .map((item) => item.path)
      .slice(0, 3);

    const text = String(userMessage || "").toLowerCase();

    if (searchRequest.type === "locate-path") {
      const first = topPaths[0];
      if (/\binstalled\b|\bwhere\b|\bpath\b/.test(text)) {
        return `Yes. It is installed at ${first}.`;
      }
      return `I found it at ${first}.`;
    }

    if (searchRequest.type === "discover-files") {
      if (topPaths.length === 1) {
        return `Yes. I found ${topPaths[0]}.`;
      }
      return `Yes. I found these matches:\n- ${topPaths.join("\n- ")}`;
    }

    return "";
  }

  _scorePathsForQuery(userMessage, paths) {
    const terms = this._extractSearchTerms(userMessage);
    const scored = Array.isArray(paths)
      ? paths.map((path) => {
          const lower = String(path || "").toLowerCase();
          let score = 0;
          for (const term of terms) {
            if (lower.includes(term)) score += term.length > 3 ? 2 : 1;
          }
          return { path, score };
        })
      : [];

    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return scored;
  }

  _rankPathsForQuery(userMessage, paths) {
    return this._scorePathsForQuery(userMessage, paths).map(
      (item) => item.path,
    );
  }

  _extractSearchTerms(userMessage) {
    const stop = new Set([
      "the",
      "and",
      "any",
      "are",
      "there",
      "this",
      "that",
      "with",
      "from",
      "have",
      "what",
      "where",
      "which",
      "system",
      "computer",
      "installed",
      "files",
      "file",
      "path",
      "please",
      "tell",
      "show",
      "look",
      "find",
    ]);

    return (
      String(userMessage || "")
        .toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.filter((term) => term.length >= 3 && !stop.has(term)) || []
    );
  }

  _buildSearchCorrectionMessage(searchRequest, allowedToolNames, cacheMatches) {
    const available = new Set(allowedToolNames || []);
    const suggestions = [];

    if (available.has("file_exists"))
      suggestions.push("try an exact likely path");
    if (available.has("list_directory"))
      suggestions.push("list likely parent folders");
    if (available.has("find_files"))
      suggestions.push("use find_files with a focused wildcard");
    if (available.has("list_registry") || available.has("read_registry")) {
      suggestions.push("check uninstall or app-path registry keys");
    }

    const hasCacheMatches =
      Array.isArray(cacheMatches) && cacheMatches.length > 0;

    return [
      "System correction: this request needs a tool-backed search before a final answer.",
      `Detected request type: ${searchRequest.type || "locate-path"}.`,
      `Do this now: ${suggestions.join(", ") || "use the available search tools"}.`,
      hasCacheMatches
        ? "Use the cached candidate paths first with file_exists or get_file_info. If a cached path fails, let the cache mark it missing and then broaden the search."
        : "If one focused wildcard search returns zero results, broaden the search instead of concluding missing.",
      "For Win98 document searches, check likely folders such as C:\\My Documents before trying NT/XP-only locations.",
      "For topic requests such as Java PDFs, search the file type and likely document folders, not only the topic word in the filename.",
      "Do not answer from assumption or after only one failed path check.",
    ].join(" ");
  }

  _buildPortfolioExecutionHint(portfolioPlan) {
    if (!portfolioPlan || !Array.isArray(portfolioPlan.asks)) return "";

    const lines = [
      `Planner detected ${portfolioPlan.askCount} ask(s) in this request.`,
      `Primary portfolio: ${portfolioPlan.primaryLabel}.`,
    ];

    for (const ask of portfolioPlan.asks.slice(0, 6)) {
      const tools = Array.isArray(ask.prioritizedTools)
        ? ask.prioritizedTools.join(", ")
        : "";
      lines.push(
        `Ask ${ask.id}: ${ask.label} — ${ask.text}${tools ? ` | prefer: ${tools}` : ""}`,
      );
    }

    lines.push(
      "Complete the asks in order unless a verified result makes a later step unnecessary. The portfolio priorities guide tool choice but do not limit allowed tools.",
    );

    return lines.join("\n");
  }

  _sanitizeUserFacingResponse(text) {
    if (typeof text !== "string") return text;

    let out = text.replace(/\r\n/g, "\n");

    out = out.replace(/```[a-z0-9_-]*\n?/gi, "");
    out = out.replace(/```/g, "");
    out = out.replace(/<br\s*\/?>/gi, "\n");
    out = out.replace(/<\/?(code|pre|strong|em|b|i|u)\b[^>]*>/gi, "");
    out = out.replace(/<\/?p\b[^>]*>/gi, "\n");
    out = out.replace(/<[^>]+>/g, "");
    out = out.replace(/^\s{0,3}#{1,6}\s*/gm, "");
    out = out.replace(/^\s*>\s?/gm, "");
    out = out.replace(/\*\*(.*?)\*\*/g, "$1");
    out = out.replace(/__(.*?)__/g, "$1");
    out = out.replace(/`([^`]*)`/g, "$1");
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
    out = out.replace(/^\s*[-*]\s+/gm, "- ");
    out = out.replace(/\n{3,}/g, "\n\n");

    return out.trim();
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

  _getMaxLoopIterations(searchRequest) {
    const envVal = parseInt(process.env.BOT_MAX_LOOP_ITERATIONS || "", 10);
    if (!Number.isNaN(envVal) && envVal > 0) return envVal;

    const model = String(this.llm.model || "").toLowerCase();
    let limit = MAX_LOOP_ITERATIONS;

    if (model.includes("grok") || model.includes("gpt-oss")) limit = 6;
    else if (model.includes("llama")) limit = 8;
    else if (model.includes("gemini")) limit = 15;

    if (searchRequest && searchRequest.requiresSearch) {
      limit = Math.max(limit, 10);
    }

    return limit;
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
