import React, { useEffect, useRef, useState } from "react";

const MAX_LINES = 500;
const DEFAULT_FILTERS = {
  info: true,
  alert: true,
  error: true,
  debug: false,
  trace: false,
};

/**
 * LogViewer — subscribes to GET /api/logs (SSE) and renders a scrolling
 * terminal-style pane. Automatically reconnects on disconnect.
 */
export default function LogViewer() {
  const [lines, setLines] = useState([]);
  const [paused, setPaused] = useState(false);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const bottomRef = useRef(null);
  const pausedRef = useRef(false);
  const pendingRef = useRef([]);

  pausedRef.current = paused;

  useEffect(() => {
    let es;
    let dead = false;

    function connect() {
      if (dead) return;
      es = new EventSource("/api/logs");

      es.onmessage = (e) => {
        const line = e.data;
        if (pausedRef.current) {
          pendingRef.current.push(line);
        } else {
          setLines((prev) => {
            const next = [...prev, line];
            return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
          });
        }
      };

      es.onerror = () => {
        es.close();
        if (!dead) setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      dead = true;
      es?.close();
    };
  }, []);

  // Auto-scroll when not paused
  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [lines, paused]);

  function togglePause() {
    if (paused) {
      // Resume: flush pending
      setLines((prev) => {
        const all = [...prev, ...pendingRef.current];
        pendingRef.current = [];
        return all.length > MAX_LINES ? all.slice(-MAX_LINES) : all;
      });
    }
    setPaused((p) => !p);
  }

  function clear() {
    setLines([]);
    pendingRef.current = [];
  }

  function toggleFilter(name) {
    setFilters((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  const visibleLines = lines.filter((line) => {
    const parsed = parseLogLine(line);
    return filters[parsed.bucket] !== false;
  });

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>Server Log</span>
        <div style={styles.filters}>
          <FilterChip
            label="Info"
            active={filters.info}
            color="#4ade80"
            onClick={() => toggleFilter("info")}
          />
          <FilterChip
            label="Alert"
            active={filters.alert}
            color="#fbbf24"
            onClick={() => toggleFilter("alert")}
          />
          <FilterChip
            label="Error"
            active={filters.error}
            color="#f87171"
            onClick={() => toggleFilter("error")}
          />
          <FilterChip
            label="Debug"
            active={filters.debug}
            color="#60a5fa"
            onClick={() => toggleFilter("debug")}
          />
          <FilterChip
            label="Trace"
            active={filters.trace}
            color="#8080a0"
            onClick={() => toggleFilter("trace")}
          />
        </div>
        <div style={styles.headerActions}>
          {paused && pendingRef.current.length > 0 && (
            <span style={styles.pending}>
              +{pendingRef.current.length} buffered
            </span>
          )}
          <button style={styles.btn} onClick={togglePause}>
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button style={styles.btn} onClick={clear}>
            Clear
          </button>
        </div>
      </div>
      <div style={styles.terminal}>
        {visibleLines.map((line, i) => (
          <LogLine key={i} raw={line} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function FilterChip({ label, active, color, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...styles.filterChip,
        ...(active
          ? { borderColor: color, color, background: "#151522" }
          : styles.filterChipOff),
      }}
    >
      {label}
    </button>
  );
}

function LogLine({ raw }) {
  const parsedLine = parseLogLine(raw);
  const { parsed, level, label, color, time, msg, extras } = parsedLine;

  if (!parsed) {
    return (
      <div style={styles.line}>
        <span style={styles.lineText}>{raw}</span>
      </div>
    );
  }

  return (
    <div style={styles.line}>
      <span style={{ ...styles.levelBadge, color }}>{label}</span>
      {time && <span style={styles.time}>{time}</span>}
      <span style={styles.lineText}>{msg}</span>
      {extras && <span style={styles.extras}> {extras}</span>}
    </div>
  );
}

function parseLogLine(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      parsed: null,
      bucket: "info",
      level: 30,
      label: "TEXT ",
      color: "#b0b0c0",
      time: "",
      msg: raw,
      extras: "",
    };
  }

  const level = parsed.level ?? 30;
  const time = parsed.time ? new Date(parsed.time).toLocaleTimeString() : "";
  const msg = parsed.msg ?? "";
  const skip = new Set(["level", "time", "pid", "hostname", "msg", "v"]);
  const extras = Object.entries(parsed)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ");

  return {
    parsed,
    bucket: levelBucket(level),
    level,
    label: levelLabel(level),
    color: levelColor(level),
    time,
    msg,
    extras,
  };
}

function levelBucket(n) {
  if (n >= 50) return "error";
  if (n >= 40) return "alert";
  if (n >= 30) return "info";
  if (n >= 20) return "debug";
  return "trace";
}

function levelLabel(n) {
  if (n >= 60) return "FATAL";
  if (n >= 50) return "ERROR";
  if (n >= 40) return "WARN ";
  if (n >= 30) return "INFO ";
  if (n >= 20) return "DEBUG";
  return "TRACE";
}

function levelColor(n) {
  if (n >= 60) return "#ff4040";
  if (n >= 50) return "#f87171";
  if (n >= 40) return "#fbbf24";
  if (n >= 30) return "#4ade80";
  if (n >= 20) return "#60a5fa";
  return "#8080a0";
}

/* ── Styles ──────────────────────────────────────────────────────────────── */
const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#0a0a12",
  },
  header: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    padding: "4px 10px",
    borderBottom: "1px solid #1e1e30",
    flexShrink: 0,
    gap: 8,
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    color: "#6060a0",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  filters: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginLeft: "auto",
  },
  filterChip: {
    padding: "2px 8px",
    background: "#11111a",
    border: "1px solid #333",
    borderRadius: 999,
    color: "#8080a0",
    cursor: "pointer",
    fontSize: 11,
  },
  filterChipOff: {
    color: "#505070",
    background: "#0d0d15",
    borderColor: "#232336",
  },
  pending: { fontSize: 10, color: "#fbbf24" },
  btn: {
    padding: "2px 8px",
    background: "#1e1e30",
    border: "1px solid #333",
    borderRadius: 4,
    color: "#8080a0",
    cursor: "pointer",
    fontSize: 11,
  },
  terminal: {
    flex: 1,
    overflowY: "auto",
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: 11,
    padding: "4px 10px",
  },
  line: {
    display: "flex",
    gap: 6,
    alignItems: "baseline",
    lineHeight: 1.6,
    borderBottom: "1px solid #0f0f1a",
  },
  levelBadge: { flexShrink: 0, fontWeight: 700, minWidth: 45 },
  time: { color: "#404060", flexShrink: 0 },
  lineText: { color: "#b0b0c0" },
  extras: { color: "#505080", fontSize: 10 },
};
