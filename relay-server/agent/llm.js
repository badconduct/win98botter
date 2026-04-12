"use strict";

/**
 * LLM API adapter.
 *
 * Supports:
 *   - Anthropic Claude (auto-detected when BOT_API_URL contains "anthropic.com")
 *   - OpenAI-compatible: OpenAI, Azure OpenAI, Ollama, LM Studio, etc.
 *
 * Internal normalised response format:
 *   {
 *     stop_reason: 'tool_use' | 'end_turn',
 *     text:        string (may be empty if stop_reason is 'tool_use'),
 *     tool_calls:  [{ id, name, input }],
 *     usage:       { input_tokens, output_tokens }
 *   }
 */

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAnthropic(apiUrl) {
  return apiUrl && apiUrl.includes("anthropic.com");
}

// ── Anthropic ────────────────────────────────────────────────────────────────

async function callAnthropic(
  apiUrl,
  apiKey,
  model,
  messages,
  tools,
  systemPrompt,
) {
  // Anthropic endpoint: <base>/messages  (base is typically https://api.anthropic.com/v1)
  const endpoint = apiUrl.replace(/\/+$/, "") + "/messages";

  const body = {
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages,
    tools: tools || [],
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Anthropic API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();

  // Extract tool calls from content blocks
  const toolCalls = [];
  let textContent = "";

  for (const block of data.content || []) {
    if (block.type === "text") {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input || {},
      });
    }
  }

  return {
    stop_reason: data.stop_reason === "tool_use" ? "tool_use" : "end_turn",
    text: textContent,
    tool_calls: toolCalls,
    // Keep the raw content array for building the assistant message in context
    _raw_content: data.content,
    usage: {
      input_tokens: (data.usage || {}).input_tokens || 0,
      output_tokens: (data.usage || {}).output_tokens || 0,
    },
  };
}

// ── OpenAI-compatible ────────────────────────────────────────────────────────

async function callOpenAI(
  apiUrl,
  apiKey,
  model,
  messages,
  tools,
  systemPrompt,
) {
  // OpenAI-compatible endpoint: <base>/chat/completions
  // Works with Ollama, LM Studio, OpenAI, Azure, etc.
  const endpoint = apiUrl.replace(/\/+$/, "") + "/chat/completions";

  // Prepend system prompt as a system message if not already there
  const allMessages = [{ role: "system", content: systemPrompt }, ...messages];

  const body = {
    model,
    messages: allMessages,
    tools: tools || undefined,
    tool_choice: tools && tools.length > 0 ? "auto" : undefined,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const choice = (data.choices || [])[0] || {};
  const msg = choice.message || {};

  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments || "{}"),
  }));

  const finishReason = choice.finish_reason || "stop";

  return {
    stop_reason:
      finishReason === "tool_calls" || finishReason === "function_call"
        ? "tool_use"
        : "end_turn",
    text: msg.content || "",
    tool_calls: toolCalls,
    _openai_message: msg,
    usage: {
      input_tokens: (data.usage || {}).prompt_tokens || 0,
      output_tokens: (data.usage || {}).completion_tokens || 0,
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

class LLMClient {
  constructor(apiUrl, apiKey, model) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.model = model;
    this._anthropic = isAnthropic(apiUrl);
  }

  /**
   * Send a conversation to the LLM and return a normalised response.
   *
   * @param {Array}  messages      Conversation history in the appropriate format for the LLM
   * @param {Array}  tools         Tool schema array (Anthropic or OpenAI format)
   * @param {string} systemPrompt  System-level instructions
   */
  async call(messages, tools, systemPrompt) {
    let attempt = 0;
    while (true) {
      try {
        if (this._anthropic) {
          return await callAnthropic(
            this.apiUrl,
            this.apiKey,
            this.model,
            messages,
            tools,
            systemPrompt,
          );
        } else {
          return await callOpenAI(
            this.apiUrl,
            this.apiKey,
            this.model,
            messages,
            tools,
            systemPrompt,
          );
        }
      } catch (err) {
        attempt++;
        if (attempt >= MAX_RETRIES) throw err;
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  isAnthropic() {
    return this._anthropic;
  }

  /**
   * Quick reachability check — call with no messages and catch errors.
   */
  async ping() {
    try {
      await this.call(
        [{ role: "user", content: "ping" }],
        [],
        "Respond with the single word: pong",
      );
      return true;
    } catch (_) {
      return false;
    }
  }
}

module.exports = LLMClient;
