import React, { useState, useEffect, useRef } from "react";
import { api } from "../api/index.js";

const LOG_MAX = 120;

const PROVIDERS = [
  {
    label: "Anthropic (Claude)",
    urlHint: "https://api.anthropic.com/v1",
    modelHint: "claude-opus-4-5",
  },
  {
    label: "OpenAI",
    urlHint: "https://api.openai.com/v1",
    modelHint: "gpt-4o",
  },
  {
    label: "Ollama (local)",
    urlHint: "http://host.docker.internal:11434/v1",
    modelHint: "llama3.1:8b",
    note: "Docker URL: host.docker.internal  |  bare-metal: localhost  \u2014  Ollama must listen on 0.0.0.0, not 127.0.0.1",
  },
  {
    label: "LM Studio (local)",
    urlHint: "http://localhost:1234/v1",
    modelHint: "local-model",
  },
  { label: "Custom / Other", urlHint: "", modelHint: "" },
];

const STEPS = ["Provider", "API Settings", "Ports", "Done"];

export default function Setup({ onDone, mode = "setup" }) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const isSettings = mode === "settings";

  // Form state
  const [providerIdx, setProviderIdx] = useState(0);
  const [apiUrl, setApiUrl] = useState(PROVIDERS[0].urlHint);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(PROVIDERS[0].modelHint);
  const [httpPort, setHttpPort] = useState("3000");
  const [tcpPort, setTcpPort] = useState("9000");

  // Connection test state
  const [testState, setTestState] = useState("idle"); // idle | testing | ok | fail
  const [testError, setTestError] = useState("");

  // Mini log viewer — always-on SSE so user can see server output
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const logEndRef = useRef(null);
  useEffect(() => {
    let es;
    let dead = false;
    function connect() {
      if (dead) return;
      es = new EventSource("/api/logs");
      es.onmessage = (ev) =>
        setLogs((prev) => {
          const next = [...prev, ev.data];
          return next.length > LOG_MAX ? next.slice(-LOG_MAX) : next;
        });
      es.onerror = () => {
        es.close();
        if (!dead) setTimeout(connect, 3000);
      };
    }
    connect();
    return () => {
      dead = true;
      es?.close();
    };
  }, []);

  useEffect(() => {
    if (!isSettings) return;

    let cancelled = false;
    api
      .getConfig()
      .then((config) => {
        if (cancelled) return;
        setApiUrl(config.BOT_API_URL || "");
        setApiKey(config.BOT_API_KEY || "");
        setModel(config.BOT_MODEL || "");
        setHttpPort(config.HTTP_PORT || "3000");
        setTcpPort(config.WIN98_LISTEN_PORT || "9000");

        const providerMatch = PROVIDERS.findIndex(
          (provider) =>
            provider.urlHint && provider.urlHint === (config.BOT_API_URL || ""),
        );
        setProviderIdx(
          providerMatch >= 0 ? providerMatch : PROVIDERS.length - 1,
        );
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });

    return () => {
      cancelled = true;
    };
  }, [isSettings]);
  useEffect(() => {
    if (showLogs) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, showLogs]);

  function pickProvider(idx) {
    setProviderIdx(idx);
    setApiUrl(PROVIDERS[idx].urlHint);
    setModel(PROVIDERS[idx].modelHint);
    setTestState("idle");
    setTestError("");
  }

  async function testConnection() {
    setTestState("testing");
    setTestError("");
    try {
      const res = await api.testConfig({
        BOT_API_URL: apiUrl,
        BOT_API_KEY: apiKey,
        BOT_MODEL: model,
      });
      if (res.ok) {
        setTestState("ok");
      } else {
        setTestState("fail");
        setTestError(res.error || "Connection failed");
      }
    } catch (e) {
      setTestState("fail");
      setTestError(e.message);
    }
  }

  async function finish() {
    setSaving(true);
    setError("");
    try {
      await api.saveConfig({
        BOT_API_URL: apiUrl,
        BOT_API_KEY: apiKey,
        BOT_MODEL: model,
        HTTP_PORT: httpPort,
        WIN98_LISTEN_PORT: tcpPort,
      });
      setStep(3);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.logo}>Win98 Botter</span>
          <span style={styles.subtitle}>
            {isSettings ? "Chatbot settings" : "First-run setup"}
          </span>
        </div>

        {/* Step indicator */}
        <div style={styles.steps}>
          {STEPS.map((s, i) => (
            <React.Fragment key={s}>
              <div
                style={{
                  ...styles.stepDot,
                  ...(i <= step ? styles.stepDotActive : {}),
                }}
              >
                {i < step ? "✓" : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div
                  style={{
                    ...styles.stepLine,
                    ...(i < step ? styles.stepLineActive : {}),
                  }}
                />
              )}
            </React.Fragment>
          ))}
        </div>
        <div style={styles.stepLabel}>
          {isSettings ? `Settings · ${STEPS[step]}` : STEPS[step]}
        </div>

        {/* Step body */}
        {step === 0 && (
          <div style={styles.body}>
            <p style={styles.hint}>Choose your AI provider.</p>
            {PROVIDERS.map((p, i) => (
              <button
                key={p.label}
                style={{
                  ...styles.providerBtn,
                  ...(i === providerIdx ? styles.providerBtnActive : {}),
                }}
                onClick={() => pickProvider(i)}
              >
                {p.label}
              </button>
            ))}
            <div style={styles.actions}>
              <span />
              <button style={styles.btn} onClick={() => setStep(1)}>
                Next →
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div style={styles.body}>
            <label style={styles.label}>API Base URL</label>
            <input
              style={styles.input}
              value={apiUrl}
              onChange={(e) => {
                setApiUrl(e.target.value);
                setTestState("idle");
              }}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
            />
            {PROVIDERS[providerIdx].note && (
              <p style={styles.providerNote}>{PROVIDERS[providerIdx].note}</p>
            )}

            <label style={styles.label}>API Key</label>
            <input
              style={styles.input}
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setTestState("idle");
              }}
              placeholder={
                providerIdx >= 2 ? "(leave blank for local servers)" : "sk-…"
              }
              autoComplete="off"
            />

            <label style={styles.label}>Model name</label>
            <input
              style={styles.input}
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setTestState("idle");
              }}
              placeholder="e.g. claude-opus-4-5"
              spellCheck={false}
            />

            {/* Test connection */}
            <div style={styles.testRow}>
              <button
                style={{
                  ...styles.testBtn,
                  ...(testState === "ok" ? styles.testBtnOk : {}),
                  ...(testState === "fail" ? styles.testBtnFail : {}),
                }}
                disabled={testState === "testing" || !apiUrl || !model}
                onClick={testConnection}
              >
                {testState === "testing" && "Testing…"}
                {testState === "idle" && "Test Connection"}
                {testState === "ok" && "✓ Connected"}
                {testState === "fail" && "✗ Retry Test"}
              </button>
              {testState === "fail" && (
                <span style={styles.testErrorMsg}>{testError}</span>
              )}
            </div>
            {testState === "fail" && (
              <div style={styles.testHints}>
                {!apiUrl.endsWith("/v1") && (
                  <p style={styles.testHint}>
                    ⚠️ Ollama’s OpenAI-compatible endpoint ends in{" "}
                    <code style={styles.code}>/v1</code>, not{" "}
                    <code style={styles.code}>/api</code>.
                  </p>
                )}
                {apiUrl.includes("localhost") && (
                  <p style={styles.testHint}>
                    ⚠️ Running inside Docker? Use{" "}
                    <code style={styles.code}>host.docker.internal</code>{" "}
                    instead of <code style={styles.code}>localhost</code>.
                  </p>
                )}
                {testError.includes("ECONNREFUSED") &&
                  (apiUrl.includes("host.docker.internal") ||
                    apiUrl.includes("127.0.0.1")) && (
                    <p style={styles.testHint}>
                      ⚠️ Ollama is refusing the connection. It is probably bound
                      to <code style={styles.code}>127.0.0.1</code> (loopback
                      only). Set{" "}
                      <code style={styles.code}>OLLAMA_HOST=0.0.0.0</code> in
                      your environment and restart Ollama, then retry.
                    </p>
                  )}
                <p style={styles.testHint}>
                  Check the server log below for details.
                </p>
              </div>
            )}

            <div style={styles.actions}>
              <button style={styles.btnSecondary} onClick={() => setStep(0)}>
                ← Back
              </button>
              <button
                style={{
                  ...styles.btn,
                  ...(testState !== "ok" ? styles.btnDimmed : {}),
                }}
                onClick={() => setStep(2)}
                disabled={testState !== "ok"}
                title={testState !== "ok" ? "Test the connection first" : ""}
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={styles.body}>
            <p style={styles.hint}>
              The relay server needs two ports. Defaults are fine for most
              setups.
            </p>

            <label style={styles.label}>HTTP port (web GUI + API)</label>
            <input
              style={styles.input}
              value={httpPort}
              onChange={(e) => setHttpPort(e.target.value)}
              placeholder="3000"
            />

            <label style={styles.label}>TCP port (Win98 agent)</label>
            <input
              style={styles.input}
              value={tcpPort}
              onChange={(e) => setTcpPort(e.target.value)}
              placeholder="9000"
            />

            {error && <p style={styles.error}>{error}</p>}

            <div style={styles.actions}>
              <button style={styles.btnSecondary} onClick={() => setStep(1)}>
                ← Back
              </button>
              <button style={styles.btn} disabled={saving} onClick={finish}>
                {saving ? "Saving…" : "Save & Start →"}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={styles.body}>
            <p style={styles.hint}>
              Configuration saved and applied — no restart needed. Click below
              to {isSettings ? "return to the dashboard" : "open the dashboard"}
              .
            </p>
            <div style={styles.actions}>
              <span />
              <button style={styles.btn} onClick={onDone}>
                {isSettings ? "Back to Dashboard →" : "Open Dashboard →"}
              </button>
            </div>
          </div>
        )}

        {/* ── Log drawer ──────────────────────────────────────────────────── */}
        <div style={styles.logDrawer}>
          <button
            style={styles.logToggle}
            onClick={() => setShowLogs((v) => !v)}
          >
            <span style={{ color: "#4060a0" }}>■</span> Server Log{" "}
            {logs.length > 0 && (
              <span style={styles.logCount}>{logs.length}</span>
            )}
            <span style={{ marginLeft: "auto", color: "#505070" }}>
              {showLogs ? "▲ hide" : "▼ show"}
            </span>
          </button>
          {showLogs && (
            <div style={styles.logScroll}>
              {logs.length === 0 && (
                <span style={{ color: "#404060" }}>No log lines yet…</span>
              )}
              {logs.map((line, i) => {
                let msg = line;
                try {
                  msg = JSON.parse(line).msg ?? line;
                } catch {}
                return (
                  <div key={i} style={styles.logLine}>
                    {msg}
                  </div>
                );
              })}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Styles ──────────────────────────────────────────────────────────────── */
const styles = {
  overlay: {
    height: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0f0f1a",
  },
  card: {
    width: 480,
    background: "#1e1e2e",
    borderRadius: 12,
    border: "1px solid #333",
    overflow: "hidden",
    boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
  },
  header: {
    background: "linear-gradient(135deg, #3b1f6e, #1a3a6e)",
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  logo: { fontSize: 20, fontWeight: 700, color: "#e0e0ff" },
  subtitle: { fontSize: 12, color: "#9090b0" },

  steps: {
    display: "flex",
    alignItems: "center",
    padding: "16px 24px 0",
  },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    background: "#2a2a3e",
    border: "2px solid #444",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    fontWeight: 700,
    color: "#666",
    flexShrink: 0,
  },
  stepDotActive: {
    background: "#6030a0",
    border: "2px solid #9060d0",
    color: "#fff",
  },
  stepLine: { flex: 1, height: 2, background: "#333", margin: "0 4px" },
  stepLineActive: { background: "#6030a0" },
  stepLabel: {
    padding: "8px 24px 0",
    fontSize: 12,
    color: "#8080a0",
    fontWeight: 600,
  },

  body: { padding: "16px 24px 24px" },
  hint: { fontSize: 13, color: "#9090b0", marginBottom: 16, lineHeight: 1.5 },

  providerBtn: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "10px 14px",
    marginBottom: 8,
    background: "#2a2a3e",
    border: "1px solid #444",
    borderRadius: 6,
    color: "#ccc",
    cursor: "pointer",
    fontSize: 13,
    transition: "background 0.15s",
  },
  providerBtnActive: {
    background: "#3d2060",
    border: "1px solid #8060c0",
    color: "#e0d0ff",
  },

  label: {
    display: "block",
    fontSize: 12,
    color: "#8080a0",
    marginBottom: 4,
    marginTop: 12,
    fontWeight: 600,
  },
  input: {
    display: "block",
    width: "100%",
    padding: "8px 10px",
    background: "#12121e",
    border: "1px solid #444",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 13,
    outline: "none",
  },

  error: { color: "#f87171", fontSize: 12, marginTop: 10 },

  actions: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 20,
  },
  btn: {
    padding: "9px 20px",
    background: "#6030a0",
    border: "none",
    borderRadius: 6,
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  btnSecondary: {
    padding: "9px 20px",
    background: "transparent",
    border: "1px solid #555",
    borderRadius: 6,
    color: "#aaa",
    cursor: "pointer",
    fontSize: 13,
  },

  providerNote: {
    fontSize: 11,
    color: "#606080",
    marginTop: 4,
    marginBottom: 0,
  },

  testRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 14,
  },
  testBtn: {
    padding: "6px 14px",
    background: "#1e1e30",
    border: "1px solid #555",
    borderRadius: 6,
    color: "#aaa",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    flexShrink: 0,
  },
  testBtnOk: {
    background: "#0a2a0a",
    border: "1px solid #2a6a2a",
    color: "#4ade80",
  },
  testBtnFail: {
    background: "#2a0a0a",
    border: "1px solid #6a2a2a",
    color: "#f87171",
  },
  testErrorMsg: {
    fontSize: 11,
    color: "#f87171",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 220,
  },

  testHints: {
    marginTop: 8,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  testHint: {
    fontSize: 11,
    color: "#a08040",
    lineHeight: 1.5,
  },
  code: {
    fontFamily: "Consolas, monospace",
    background: "#0f0f1a",
    padding: "1px 4px",
    borderRadius: 3,
    color: "#d0b060",
  },

  btnDimmed: {
    opacity: 0.4,
    cursor: "not-allowed",
  },

  // Log drawer
  logDrawer: {
    borderTop: "1px solid #222",
    background: "#0a0a14",
  },
  logToggle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "6px 14px",
    background: "transparent",
    border: "none",
    color: "#606080",
    fontSize: 11,
    cursor: "pointer",
    fontWeight: 600,
    letterSpacing: 0.5,
  },
  logCount: {
    background: "#1a1a30",
    border: "1px solid #333",
    borderRadius: 8,
    padding: "0 5px",
    fontSize: 10,
    color: "#5050a0",
  },
  logScroll: {
    maxHeight: 120,
    overflowY: "auto",
    padding: "4px 10px 8px",
    fontFamily: "Consolas, monospace",
    fontSize: 10,
    color: "#5a5a8a",
  },
  logLine: {
    lineHeight: 1.6,
    borderBottom: "1px solid #0f0f1a",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};
