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

const { ContextBuilder, buildSystemPrompt } = require("./context");
const { schemaList, openaiSchemaList } = require("../win98/tools");
const queries = require("../db/queries");

const MAX_LOOP_ITERATIONS = 20;

class AgentLoop {
  constructor(llmClient, win98Client, stagingManager, permissions, logger) {
    this.llm = llmClient;
    this.win98 = win98Client;
    this.staging = stagingManager;
    this.perms = permissions;
    this.log = logger;
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
    );

    // Load session history
    const historyRows = queries.getRecentMessages(sessionId, 30);

    // Build context
    const ctx = new ContextBuilder(tokenBudget, isAnthropic);
    ctx.loadHistory(historyRows);
    ctx.addUserMessage(userMessage);

    // Save user message to DB
    queries.saveMessage(sessionId, "user", userMessage);

    let llmCallCount = 0;
    let toolCallCount = 0;
    let totalTokens = 0;
    let finalResponse = "";

    for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
      if (ctx.isOverBudget()) ctx.trim();

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
        finalResponse = llmResp.text;
        break;
      }

      // ── Execute tool calls ────────────────────────────────────────────────
      const toolResults = [];

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
    }

    // Save final assistant response
    queries.saveMessage(sessionId, "assistant", finalResponse);

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
}

module.exports = AgentLoop;
