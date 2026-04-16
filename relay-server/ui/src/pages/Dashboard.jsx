import React, { useEffect, useState, useCallback } from "react";
import { api } from "../api/index.js";
import AgentTabs from "../components/AgentTabs.jsx";
import ChatPanel from "../components/ChatPanel.jsx";
import SystemPrompt from "../components/SystemPrompt.jsx";
import FileActivity from "../components/FileActivity.jsx";
import LogViewer from "../components/LogViewer.jsx";

const POLL_MS = 4000;

export default function Dashboard() {
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [globalError, setGlobalError] = useState("");

  // Poll agent list
  const refreshAgents = useCallback(async () => {
    try {
      const list = await api.listAgents();
      setAgents(list);
      // Auto-select first online agent if nothing selected
      setSelectedAgent((prev) => {
        if (prev) return prev;
        const online = list.find((a) => a.online);
        return online ? online.agentId : (list[0]?.agentId ?? null);
      });
    } catch (e) {
      setGlobalError("Could not reach relay server: " + e.message);
    }
  }, []);

  useEffect(() => {
    refreshAgents();
    const t = setInterval(refreshAgents, POLL_MS);
    return () => clearInterval(t);
  }, [refreshAgents]);

  const removeAgent = useCallback(
    async (agentId) => {
      try {
        await api.removeAgent(agentId);
        setAgents((prev) => prev.filter((agent) => agent.agentId !== agentId));
        setSelectedAgent((prev) => {
          if (prev !== agentId) return prev;
          const remaining = agents.filter((agent) => agent.agentId !== agentId);
          const online = remaining.find((agent) => agent.online);
          return online ? online.agentId : (remaining[0]?.agentId ?? null);
        });
      } catch (e) {
        setGlobalError("Could not remove agent: " + e.message);
      }
    },
    [agents],
  );

  const current = agents.find((a) => a.agentId === selectedAgent) ?? null;

  return (
    <div style={styles.root}>
      {/* Top bar */}
      <div style={styles.topbar}>
        <span style={styles.brandName}>Win98 Botter</span>
        {globalError && <span style={styles.topbarError}>{globalError}</span>}
        <a href="/settings" style={styles.settingsLink}>
          ⚙ Settings
        </a>
      </div>

      {/* Agent tabs */}
      <AgentTabs
        agents={agents}
        selected={selectedAgent}
        onSelect={setSelectedAgent}
        onRemove={removeAgent}
      />

      {/* Main content — split layout */}
      {current ? (
        <div style={styles.content}>
          {/* Left: Chat panel */}
          <div style={styles.left}>
            <ChatPanel agent={current} />
          </div>

          {/* Right: 3-pane column */}
          <div style={styles.right}>
            <div style={styles.rightPaneTop}>
              <SystemPrompt agent={current} />
            </div>
            <div style={styles.rightPaneMid}>
              <FileActivity agent={current} />
            </div>
            <div style={styles.rightPaneBot}>
              <LogViewer agentId={current.agentId} />
            </div>
          </div>
        </div>
      ) : (
        <div style={styles.content}>
          {/* Left: waiting panel */}
          <div style={styles.left}>
            <div style={styles.waitingPanel}>
              <div style={styles.pulseRing} />
              <h2 style={styles.waitingTitle}>Waiting for Win98 agents…</h2>
              <p style={styles.waitingBody}>
                No agents are connected yet. Start the Win98 MCP service on your
                Windows 98 machine and it will appear here automatically.
              </p>
              <div style={styles.infoGrid}>
                <div style={styles.infoItem}>
                  <span style={styles.infoLabel}>Agent TCP port</span>
                  <span style={styles.infoValue}>9000</span>
                </div>
                <div style={styles.infoItem}>
                  <span style={styles.infoLabel}>Web GUI port</span>
                  <span style={styles.infoValue}>3000</span>
                </div>
                <div style={styles.infoItem}>
                  <span style={styles.infoLabel}>Server status</span>
                  <span style={{ ...styles.infoValue, color: "#4ade80" }}>
                    ● Running
                  </span>
                </div>
                <div style={styles.infoItem}>
                  <span style={styles.infoLabel}>Agents connected</span>
                  <span style={styles.infoValue}>{agents.length}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right: log viewer is useful even before agents connect */}
          <div style={styles.right}>
            <div style={{ flex: 1, overflow: "hidden" }}>
              <LogViewer />
            </div>
          </div>
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
    height: "100vh",
    background: "#0f0f1a",
    overflow: "hidden",
  },
  topbar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "0 16px",
    height: 44,
    background: "#1a1a2e",
    borderBottom: "1px solid #2a2a3e",
    flexShrink: 0,
  },
  brandName: { fontWeight: 700, fontSize: 15, color: "#c0b0ff" },
  topbarError: { flex: 1, fontSize: 12, color: "#f87171" },
  settingsLink: {
    marginLeft: "auto",
    color: "#8080a0",
    fontSize: 13,
    textDecoration: "none",
  },

  content: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  left: {
    flex: "0 0 55%",
    borderRight: "1px solid #2a2a3e",
    overflow: "hidden",
  },
  right: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  rightPaneTop: {
    flex: "0 0 30%",
    borderBottom: "1px solid #2a2a3e",
    overflow: "hidden",
  },
  rightPaneMid: {
    flex: "0 0 35%",
    borderBottom: "1px solid #2a2a3e",
    overflow: "hidden",
  },
  rightPaneBot: { flex: 1, overflow: "hidden" },

  // No-agent waiting state
  waitingPanel: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    padding: "0 40px",
    gap: 16,
  },
  pulseRing: {
    width: 48,
    height: 48,
    borderRadius: "50%",
    border: "3px solid #5030a0",
    boxShadow: "0 0 0 0 rgba(80,48,160,0.4)",
    animation: "pulse 2s infinite",
  },
  waitingTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#c0b0ff",
    margin: 0,
    textAlign: "center",
  },
  waitingBody: {
    fontSize: 13,
    color: "#6060a0",
    textAlign: "center",
    lineHeight: 1.6,
    maxWidth: 360,
    margin: 0,
  },
  infoGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    marginTop: 8,
    width: "100%",
    maxWidth: 340,
  },
  infoItem: {
    background: "#1a1a2e",
    border: "1px solid #2a2a3e",
    borderRadius: 8,
    padding: "10px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  infoLabel: {
    fontSize: 10,
    color: "#505070",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  infoValue: {
    fontSize: 15,
    color: "#9080d0",
    fontWeight: 700,
    fontFamily: "monospace",
  },

  empty: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    color: "#5050a0",
    fontSize: 14,
  },
};
