import React, { useEffect, useState } from "react";
import { api } from "../api/index.js";

const CUSTOM_PROMPT_KEY = "win98botter.customSystemPrompt";

/**
 * SystemPrompt — shows the live server-generated system prompt for this agent,
 * plus an editable custom prefix that will be prepended on every chat message.
 */
export default function SystemPrompt({ agent }) {
  const [serverPrompt, setServerPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const [editingCustom, setEditingCustom] = useState(false);
  const [saved, setSaved] = useState(false);

  const agentId = agent?.agentId;

  // Fetch the live system prompt from the server whenever the agent changes
  useEffect(() => {
    if (!agentId) return;
    setLoading(true);
    api
      .getSystemPrompt(agentId)
      .then((data) => setServerPrompt(data?.prompt ?? ""))
      .catch(() => setServerPrompt("(failed to load)"))
      .finally(() => setLoading(false));
  }, [agentId]);

  // Load saved custom prompt from localStorage
  useEffect(() => {
    setCustomPrompt(localStorage.getItem(CUSTOM_PROMPT_KEY) ?? "");
    setEditingCustom(false);
    setSaved(false);
  }, [agentId]);

  function saveCustom() {
    localStorage.setItem(CUSTOM_PROMPT_KEY, customPrompt);
    setSaved(true);
    setEditingCustom(false);
    setTimeout(() => setSaved(false), 2000);
  }

  const previewLines = 6;
  const serverLines = serverPrompt.split("\n");
  const previewText = serverLines.slice(0, previewLines).join("\n");
  const isLong = serverLines.length > previewLines;

  return (
    <div style={styles.root}>
      {/* ── Server prompt (read-only) ── */}
      <div style={styles.sectionHeader}>
        <span style={styles.title}>System Prompt</span>
        <span style={styles.badge}>auto-generated</span>
        {isLong && (
          <button style={styles.btn} onClick={() => setShowFull((f) => !f)}>
            {showFull ? "Collapse" : "Expand"}
          </button>
        )}
      </div>
      <div style={styles.promptView}>
        {loading ? (
          <p style={styles.empty}>Loading…</p>
        ) : serverPrompt ? (
          <pre style={styles.promptText}>
            {showFull || !isLong ? serverPrompt : previewText + "\n…"}
          </pre>
        ) : (
          <p style={styles.empty}>No agent connected.</p>
        )}
      </div>

      {/* ── User custom prefix (editable) ── */}
      <div style={styles.sectionHeader}>
        <span style={styles.title}>Custom Prefix</span>
        <span style={styles.badge}>prepended to each message</span>
        <div style={styles.headerActions}>
          {saved && <span style={styles.savedBadge}>Saved ✓</span>}
          {!editingCustom ? (
            <button style={styles.btn} onClick={() => setEditingCustom(true)}>
              Edit
            </button>
          ) : (
            <>
              <button style={styles.btn} onClick={saveCustom}>
                Save
              </button>
              <button
                style={{ ...styles.btn, ...styles.btnCancel }}
                onClick={() => {
                  setCustomPrompt(
                    localStorage.getItem(CUSTOM_PROMPT_KEY) ?? "",
                  );
                  setEditingCustom(false);
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {editingCustom ? (
        <textarea
          style={styles.promptEditor}
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder="Optional instructions prepended before every message you send…"
          spellCheck={false}
        />
      ) : (
        <div style={{ ...styles.promptView, flexShrink: 0, maxHeight: 80 }}>
          {customPrompt ? (
            <pre style={styles.promptText}>{customPrompt}</pre>
          ) : (
            <p style={styles.empty}>
              None. Click Edit to add custom instructions.
            </p>
          )}
        </div>
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
    background: "#0e0e1c",
    overflow: "hidden",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    borderBottom: "1px solid #1e1e30",
    flexShrink: 0,
    borderTop: "1px solid #1a1a2c",
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    color: "#6060a0",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  badge: {
    fontSize: 9,
    color: "#3a3a6a",
    background: "#1a1a30",
    borderRadius: 3,
    padding: "1px 5px",
    fontFamily: "Consolas, monospace",
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginLeft: "auto",
  },
  savedBadge: { fontSize: 10, color: "#4ade80" },
  btn: {
    marginLeft: "auto",
    padding: "2px 8px",
    background: "#1e1e30",
    border: "1px solid #333",
    borderRadius: 4,
    color: "#8080a0",
    cursor: "pointer",
    fontSize: 11,
  },
  btnCancel: { color: "#f87171", borderColor: "#5a2020", marginLeft: 0 },
  promptView: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 10px",
    minHeight: 0,
  },
  promptText: {
    fontSize: 11,
    color: "#7070a0",
    fontFamily: "Consolas, monospace",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    margin: 0,
    lineHeight: 1.5,
  },
  empty: { color: "#3a3a5a", fontSize: 12, margin: 0 },
  promptEditor: {
    flexShrink: 0,
    height: 80,
    resize: "none",
    background: "#07070f",
    border: "none",
    borderTop: "1px solid #2a2a3e",
    color: "#b0b0c0",
    fontSize: 12,
    padding: "8px 10px",
    fontFamily: "Consolas, monospace",
    outline: "none",
    lineHeight: 1.5,
  },
};
