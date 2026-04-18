import React, { useEffect, useRef, useState, useCallback } from "react";
import { api } from "../api/index.js";

const POLL_MS = 5000;
const MAX_MSGS = 200;
const CHAT_SOURCE = "administrator";

/**
 * ChatPanel — shows the session message history for this agent,
 * with tool calls displayed as collapsible rows.
 * Also provides an input to send a new user message.
 */
export default function ChatPanel({ agent }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef(null);

  const agentId = agent?.agentId;

  const fetchHistory = useCallback(async () => {
    if (!agentId) return;
    try {
      const data = await api.getHistory(agentId, undefined, CHAT_SOURCE);
      setMessages((data?.messages ?? []).slice(-MAX_MSGS));
    } catch {
      /* silently ignore poll errors */
    }
  }, [agentId]);

  // Initial fetch + polling
  useEffect(() => {
    setMessages([]);
    fetchHistory();
    const t = setInterval(fetchHistory, POLL_MS);
    return () => clearInterval(t);
  }, [fetchHistory]);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    setInput("");
    try {
      const customPrefix =
        localStorage.getItem("win98botter.customSystemPrompt") ?? "";
      const message = customPrefix ? `${customPrefix}\n\n${text}` : text;
      await api.sendChat({
        message,
        agent_id: agentId,
        source: CHAT_SOURCE,
      });
      await fetchHistory();
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>Admin Chat</span>
        {agent.hostname && (
          <span style={styles.agentLabel}>{agent.hostname}</span>
        )}
        {!agent.online && <span style={styles.offlineBadge}>offline</span>}
      </div>

      <div style={styles.messages}>
        {messages.length === 0 && (
          <p style={styles.empty}>
            No messages yet. Start a conversation below.
          </p>
        )}
        {messages.map((msg, i) => (
          <MessageRow key={i} msg={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.inputRow}>
        <textarea
          style={styles.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            agent.online ? "Send a message… (Enter to send)" : "Agent offline"
          }
          disabled={!agent.online || sending}
          rows={2}
        />
        <button
          style={{
            ...styles.sendBtn,
            opacity: !agent.online || sending ? 0.4 : 1,
          }}
          disabled={!agent.online || sending}
          onClick={send}
        >
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function MessageRow({ msg }) {
  const { role, content } = msg;
  const isUser = role === "user";
  const isAssistant = role === "assistant";
  const isToolResult = role === "tool";

  if (isToolResult) return null; // collapsed into the tool call above

  if (typeof content === "string") {
    return (
      <div
        style={{
          ...styles.bubble,
          ...(isUser ? styles.userBubble : styles.aiBubble),
        }}
      >
        <span style={styles.roleLabel}>{isUser ? "You" : "Bot"}</span>
        <p style={styles.text}>{content}</p>
      </div>
    );
  }

  // Content is an array (can include tool_use blocks)
  const parts = Array.isArray(content) ? content : [];
  return (
    <div
      style={{
        ...styles.bubble,
        ...(isUser ? styles.userBubble : styles.aiBubble),
      }}
    >
      <span style={styles.roleLabel}>{isUser ? "You" : "Bot"}</span>
      {parts.map((part, i) => {
        if (part.type === "text") {
          return (
            <p key={i} style={styles.text}>
              {part.text}
            </p>
          );
        }
        if (part.type === "tool_use") {
          return <ToolCallBlock key={i} block={part} />;
        }
        return null;
      })}
    </div>
  );
}

function ToolCallBlock({ block }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={styles.toolBlock}>
      <button style={styles.toolHeader} onClick={() => setOpen((o) => !o)}>
        <span style={styles.toolIcon}>⚙</span>
        <code style={styles.toolName}>{block.name}</code>
        <span style={styles.toolToggle}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <pre style={styles.toolBody}>
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

/* ── Styles ──────────────────────────────────────────────────────────────── */
const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#0d0d1a",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 12px",
    borderBottom: "1px solid #1e1e30",
    flexShrink: 0,
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    color: "#6060a0",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  agentLabel: { fontSize: 11, color: "#7060b0" },
  offlineBadge: {
    fontSize: 10,
    color: "#666",
    background: "#1e1e2e",
    border: "1px solid #444",
    borderRadius: 4,
    padding: "1px 6px",
  },

  messages: {
    flex: 1,
    overflowY: "auto",
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  empty: { color: "#3a3a5a", fontSize: 13, textAlign: "center", marginTop: 40 },

  bubble: {
    maxWidth: "90%",
    padding: "8px 12px",
    borderRadius: 8,
    fontSize: 13,
    lineHeight: 1.5,
  },
  userBubble: {
    background: "#1a1a30",
    alignSelf: "flex-end",
    border: "1px solid #2a2a40",
  },
  aiBubble: {
    background: "#130d28",
    alignSelf: "flex-start",
    border: "1px solid #2a1a40",
  },
  roleLabel: {
    display: "block",
    fontSize: 10,
    fontWeight: 700,
    color: "#5050a0",
    marginBottom: 3,
  },
  text: {
    color: "#ccc",
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },

  toolBlock: { marginTop: 4 },
  toolHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "#0f0a20",
    border: "1px solid #3a2060",
    borderRadius: 5,
    padding: "3px 8px",
    cursor: "pointer",
    width: "100%",
    textAlign: "left",
  },
  toolIcon: { color: "#7060b0", fontSize: 10 },
  toolName: {
    color: "#b090e0",
    fontSize: 11,
    flex: 1,
    fontFamily: "monospace",
  },
  toolToggle: { color: "#555", fontSize: 9 },
  toolBody: {
    background: "#070710",
    border: "1px solid #2a1a40",
    borderTop: "none",
    borderRadius: "0 0 5px 5px",
    padding: "6px 10px",
    fontSize: 11,
    color: "#9090c0",
    overflowX: "auto",
    margin: 0,
    fontFamily: "Consolas, monospace",
  },

  error: {
    padding: "4px 12px",
    background: "#2a0a0a",
    color: "#f87171",
    fontSize: 12,
    flexShrink: 0,
  },

  inputRow: {
    display: "flex",
    gap: 8,
    padding: "8px 12px",
    borderTop: "1px solid #1e1e30",
    flexShrink: 0,
  },
  textarea: {
    flex: 1,
    resize: "none",
    background: "#0a0a16",
    border: "1px solid #2a2a3e",
    borderRadius: 6,
    color: "#ccc",
    fontSize: 13,
    padding: "6px 10px",
    outline: "none",
    fontFamily: "inherit",
  },
  sendBtn: {
    padding: "0 16px",
    background: "#5020a0",
    border: "none",
    borderRadius: 6,
    color: "#fff",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 13,
  },
};
