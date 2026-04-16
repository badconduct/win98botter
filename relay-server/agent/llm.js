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

const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 2000;

function parseRetryDelaySeconds(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function parseRetryDelayMsFromErrorPayload(payload) {
  try {
    const details =
      payload && payload.error && Array.isArray(payload.error.details)
        ? payload.error.details
        : [];
    for (const d of details) {
      if (d && typeof d.retryDelay === "string") {
        const sec = parseRetryDelaySeconds(d.retryDelay);
        if (sec && sec > 0) return sec * 1000;
      }
    }
  } catch (_) {
    // ignore parse errors
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAnthropic(apiUrl) {
  return apiUrl && apiUrl.includes("anthropic.com");
}

function normalizeApiUrl(apiUrl) {
  const localBase =
    String(process.env.BOT_LOCAL_LLM_BASE || "").trim() ||
    "http://host.docker.internal:11434";
  const raw = String(apiUrl || "").trim();

  // Safe default for local Ollama OpenAI-compatible endpoint.
  if (!raw) return `${localBase.replace(/\/+$/, "")}/v1`;

  // If user provided a relative path (e.g. "/v1"), anchor it to local Ollama.
  if (raw.startsWith("/")) return `${localBase.replace(/\/+$/, "")}${raw}`;

  // Ensure absolute URL; fallback to local Ollama if invalid.
  try {
    const parsed = new URL(raw);
    let out = parsed.toString().replace(/\/+$/, "");

    // Users often provide full endpoints; convert them back to base URL.
    out = out.replace(/\/chat\/completions$/i, "");
    out = out.replace(/\/v1\/messages$/i, "/v1");
    return out;
  } catch (_) {
    return `${localBase.replace(/\/+$/, "")}/v1`;
  }
}

function normalizeToolName(name) {
  if (typeof name !== "string") return "";
  let cleaned = name.trim();

  // Ollama harmony can append channel suffixes, e.g.:
  // file_exists<|channel|>commentary
  cleaned = cleaned.replace(/<\|channel\|>.*$/i, "");

  // Be defensive against other token artifacts.
  cleaned = cleaned.replace(/[\s`"']+/g, "");

  return cleaned;
}

function getOpenAIMaxOutputTokens(apiUrl, model) {
  const envVal = parseInt(process.env.BOT_MAX_OUTPUT_TOKENS || "", 10);
  if (!Number.isNaN(envVal) && envVal > 0) return envVal;

  if (process.env.BOT_LOW_RESOURCE === "1") return 220;

  const url = String(apiUrl || "").toLowerCase();
  const m = String(model || "").toLowerCase();

  if (url.includes("api.groq.com") || m.includes("grok")) return 400;
  if (m.includes("gemini")) return 500;
  if (m.includes("gpt-oss") || m.includes("llama")) return 600;
  return 800;
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
        name: normalizeToolName(block.name),
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
    max_tokens: getOpenAIMaxOutputTokens(apiUrl, model),
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
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (_) {
      parsed = null;
    }

    const err = new Error(`LLM API error ${resp.status}: ${text}`);
    err.status = resp.status;

    const headerDelay = parseRetryDelaySeconds(resp.headers.get("retry-after"));
    const bodyDelayMs = parseRetryDelayMsFromErrorPayload(parsed);
    if (headerDelay && headerDelay > 0) err.retryAfterMs = headerDelay * 1000;
    else if (bodyDelayMs) err.retryAfterMs = bodyDelayMs;

    throw err;
  }

  const data = await resp.json();
  const choice = (data.choices || [])[0] || {};
  const msg = choice.message || {};

  const toolCalls = (msg.tool_calls || []).map((tc) => {
    let parsedInput = {};
    try {
      parsedInput = JSON.parse((tc.function && tc.function.arguments) || "{}");
    } catch (_) {
      parsedInput = {};
    }

    return {
      id: tc.id,
      name: normalizeToolName(tc.function && tc.function.name),
      input: parsedInput,
    };
  });

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
    this.apiUrl = normalizeApiUrl(apiUrl);
    this.apiKey = apiKey;
    this.model = model;
    this._anthropic = isAnthropic(this.apiUrl);
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

        const retryMs =
          err && typeof err.retryAfterMs === "number" && err.retryAfterMs > 0
            ? err.retryAfterMs
            : RETRY_DELAY_MS * Math.max(1, attempt);

        await sleep(retryMs);
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
