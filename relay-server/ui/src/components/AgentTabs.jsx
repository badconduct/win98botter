import React from "react";

export default function AgentTabs({ agents, selected, onSelect, onRemove }) {
  if (agents.length === 0) return null;

  return (
    <div style={styles.bar}>
      {agents.map((agent) => {
        const isSelected = agent.agentId === selected;
        const isOnline = agent.online;
        return (
          <div
            key={agent.agentId}
            style={{
              ...styles.tab,
              ...(isSelected ? styles.tabActive : {}),
            }}
            onClick={() => onSelect(agent.agentId)}
            title={agent.agentId}
            role="button"
          >
            <span
              style={{
                ...styles.dot,
                background: isOnline ? "#4ade80" : "#555",
              }}
            />
            <span style={styles.label}>
              {agent.hostname || shortId(agent.agentId)}
            </span>
            {agent.host && <span style={styles.ip}>{agent.host}</span>}
            <button
              type="button"
              style={styles.removeBtn}
              title="Disconnect and remove this agent"
              onClick={(event) => {
                event.stopPropagation();
                onRemove?.(agent.agentId);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

function shortId(id) {
  if (!id) return "?";
  // Show last 8 chars of UUID-style id
  return id.length > 8 ? "…" + id.slice(-8) : id;
}

/* ── Styles ──────────────────────────────────────────────────────────────── */
const styles = {
  bar: {
    display: "flex",
    flexShrink: 0,
    overflowX: "auto",
    background: "#12121e",
    borderBottom: "1px solid #2a2a3e",
    gap: 2,
    padding: "4px 8px",
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 12px",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 5,
    cursor: "pointer",
    color: "#8080b0",
    fontSize: 12,
    whiteSpace: "nowrap",
    transition: "background 0.1s",
  },
  tabActive: {
    background: "#2a2040",
    border: "1px solid #5030a0",
    color: "#d0c0ff",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  },
  label: { fontWeight: 600 },
  ip: { color: "#555", fontSize: 10 },
  removeBtn: {
    marginLeft: 6,
    width: 18,
    height: 18,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    border: "1px solid #503040",
    background: "#24161f",
    color: "#f0a4b5",
    cursor: "pointer",
    fontSize: 12,
    lineHeight: 1,
    padding: 0,
    flexShrink: 0,
  },
};
