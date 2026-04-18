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
  const [flags, setFlags] = useState({});
  const [permissions, setPermissions] = useState({});

  const agentId = agent?.agentId;

  // Fetch the live system prompt from the server whenever the agent changes
  useEffect(() => {
    if (!agentId) return;
    setLoading(true);
    api
      .getSystemPrompt(agentId)
      .then((data) => {
        setServerPrompt(data?.prompt ?? "");
        setFlags(data?.flags ?? {});
        setPermissions(data?.permissions ?? {});
      })
      .catch(() => setServerPrompt("(failed to load)"))
      .finally(() => setLoading(false));
  }, [agentId]);

  async function toggleFlag(name) {
    if (!agentId) return;
    const next = { ...flags, [name]: !flags[name] };
    setFlags(next);
    try {
      const res = await api.setSystemPromptFlags(agentId, next);
      setFlags(res?.flags ?? next);
      const data = await api.getSystemPrompt(agentId);
      setServerPrompt(data?.prompt ?? "");
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } catch {
      // revert on error
      setFlags(flags);
    }
  }

  async function togglePermission(name) {
    if (!agentId || agent?.online === false) return;
    const next = { ...permissions, [name]: !permissions[name] };
    setPermissions(next);
    try {
      const res = await api.setAgentPermissions(agentId, next);
      setPermissions(res?.permissions ?? next);
      const data = await api.getSystemPrompt(agentId);
      setServerPrompt(data?.prompt ?? "");
      setFlags(data?.flags ?? {});
      setPermissions(data?.permissions ?? res?.permissions ?? next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } catch {
      // revert on error
      setPermissions(permissions);
    }
  }

  const PERMISSION_ORDER = [
    ["file_read", "file_read"],
    ["file_write", "file_write"],
    ["registry_read", "registry_read"],
    ["registry_write", "registry_write"],
    ["execute", "execute"],
    ["process_kill", "process_kill"],
    ["hardware_io", "hardware_io"],
    ["serial", "serial"],
    ["scheduler", "scheduler"],
    ["screenshot", "screenshot"],
    ["system", "system"],
  ];

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
        <div style={styles.flagsRow}>
          {[
            ["execution_patterns", "Exec"],
            ["crash_protocol", "Crash"],
            ["investigation_first", "Investigate"],
            ["platform_notes", "Platform"],
            ["capability_tiers", "Tiers"],
            ["sensory_verification", "Sensory"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              style={{
                ...styles.flagBtn,
                ...(flags[key] !== false
                  ? styles.flagBtnOn
                  : styles.flagBtnOff),
              }}
              onClick={() => toggleFlag(key)}
              title={`Toggle ${label} section`}
            >
              {label}
            </button>
          ))}
        </div>
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

      <div style={styles.sectionHeader}>
        <span style={styles.title}>Active Permissions</span>
        <span style={styles.badge}>
          {agent?.online === false ? "offline (read-only)" : "click to toggle"}
        </span>
      </div>
      <div style={styles.permissionsWrap}>
        {PERMISSION_ORDER.map(([key, label]) => {
          const enabled = permissions[key] !== false;
          return (
            <button
              key={key}
              type="button"
              style={{
                ...styles.permBtn,
                ...(enabled ? styles.permBtnOn : styles.permBtnOff),
                ...(agent?.online === false ? styles.permBtnDisabled : {}),
              }}
              onClick={() => togglePermission(key)}
              disabled={agent?.online === false}
              title={
                agent?.online === false
                  ? "Agent offline: reconnect to change permissions"
                  : `Toggle ${label}`
              }
            >
              <span style={styles.permSymbol}>{enabled ? "✓" : "✗"}</span>
              <span>{label}</span>
            </button>
          );
        })}
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
  flagsRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    marginLeft: 8,
    flexWrap: "wrap",
  },
  flagBtn: {
    padding: "1px 6px",
    borderRadius: 999,
    border: "1px solid #333",
    background: "#11111a",
    color: "#8080a0",
    cursor: "pointer",
    fontSize: 10,
  },
  flagBtnOn: {
    borderColor: "#4a3a7a",
    color: "#b8a8ff",
    background: "#181328",
  },
  flagBtnOff: {
    color: "#555577",
    background: "#0d0d15",
    borderColor: "#24243a",
  },
  permissionsWrap: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    padding: "8px 10px",
    borderBottom: "1px solid #1e1e30",
    background: "#090913",
    flexShrink: 0,
  },
  permBtn: {
    padding: "3px 8px",
    borderRadius: 999,
    border: "1px solid #2a2a40",
    background: "#10101a",
    color: "#7f7f9f",
    cursor: "pointer",
    fontSize: 10,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontFamily: "Consolas, monospace",
  },
  permBtnOn: {
    borderColor: "#245834",
    color: "#8de3a3",
    background: "#0f1f14",
  },
  permBtnOff: {
    borderColor: "#5a2525",
    color: "#fca5a5",
    background: "#241111",
  },
  permBtnDisabled: {
    opacity: 0.55,
    cursor: "not-allowed",
  },
  permSymbol: {
    fontWeight: 700,
    width: 8,
    display: "inline-block",
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
