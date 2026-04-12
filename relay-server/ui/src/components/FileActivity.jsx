import React, { useEffect, useRef, useState, useCallback } from "react";
import { api } from "../api/index.js";

const POLL_MS = 4000;

const FILE_OPS = new Set([
  "read_file",
  "write_file",
  "write_file_binary",
  "append_file",
  "delete_file",
  "copy_file",
  "move_file",
  "get_file_info",
  "list_directory",
  "grep_file",
  "file_exists",
]);

const REG_OPS = new Set([
  "read_registry",
  "write_registry",
  "delete_registry",
  "list_registry",
]);

/**
 * FileActivity — shows tool calls from history that are file or registry ops.
 * Registry writes are flagged in amber.
 */
export default function FileActivity({ agent }) {
  const [rows, setRows] = useState([]);
  const agentId = agent?.agentId;

  const fetch = useCallback(async () => {
    if (!agentId) return;
    try {
      const data = await api.getHistory(agentId);
      const msgs = data?.messages ?? [];
      const out = [];
      for (const msg of msgs) {
        if (msg.role !== "assistant") continue;
        const parts = Array.isArray(msg.content) ? msg.content : [];
        for (const part of parts) {
          if (part.type !== "tool_use") continue;
          if (!FILE_OPS.has(part.name) && !REG_OPS.has(part.name)) continue;
          out.push({
            id: part.id ?? Math.random().toString(36).slice(2),
            op: part.name,
            path:
              part.input?.path ??
              part.input?.key ??
              part.input?.filename ??
              "—",
            isReg: REG_OPS.has(part.name),
            isWrite: isWriteOp(part.name),
            input: part.input,
          });
        }
      }
      setRows(out.slice(-200));
    } catch {
      /* polling: ignore */
    }
  }, [agentId]);

  useEffect(() => {
    setRows([]);
    fetch();
    const t = setInterval(fetch, POLL_MS);
    return () => clearInterval(t);
  }, [fetch]);

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>File Activity</span>
        <span style={styles.count}>{rows.length} ops</span>
      </div>
      <div style={styles.scroll}>
        {rows.length === 0 ? (
          <p style={styles.empty}>No file operations yet.</p>
        ) : (
          <table style={styles.table}>
            <tbody>
              {rows.map((row) => (
                <ActivityRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function isWriteOp(name) {
  return [
    "write_file",
    "write_file_binary",
    "append_file",
    "delete_file",
    "move_file",
    "copy_file",
    "write_registry",
    "delete_registry",
  ].includes(name);
}

function ActivityRow({ row }) {
  const [open, setOpen] = useState(false);
  const flag = row.isReg && row.isWrite;
  return (
    <>
      <tr
        style={{
          ...styles.row,
          cursor: "pointer",
          ...(flag ? styles.rowFlag : {}),
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <td style={styles.opCell}>
          <span
            style={{
              ...styles.opBadge,
              ...(row.isReg
                ? styles.opReg
                : row.isWrite
                  ? styles.opWrite
                  : styles.opRead),
            }}
          >
            {shortOp(row.op)}
          </span>
        </td>
        <td style={styles.pathCell} title={row.path}>
          {row.path}
        </td>
        {flag && <td style={styles.flagCell}>⚠ REG WRITE</td>}
      </tr>
      {open && (
        <tr>
          <td colSpan={3} style={styles.detailCell}>
            <pre style={styles.detailPre}>
              {JSON.stringify(row.input, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

function shortOp(name) {
  const map = {
    read_file: "READ",
    write_file: "WRITE",
    append_file: "APPEND",
    delete_file: "DEL",
    copy_file: "COPY",
    move_file: "MOVE",
    list_directory: "DIR",
    grep_file: "GREP",
    file_exists: "EXIST",
    get_file_info: "STAT",
    write_file_binary: "BINWRT",
    read_registry: "RDREG",
    write_registry: "WRREG",
    delete_registry: "DELREG",
    list_registry: "LSREG",
  };
  return map[name] ?? name.toUpperCase().slice(0, 6);
}

/* ── Styles ──────────────────────────────────────────────────────────────── */
const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#0c0c18",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 10px",
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
  count: { fontSize: 10, color: "#505060", marginLeft: "auto" },
  scroll: { flex: 1, overflowY: "auto" },
  empty: { color: "#3a3a5a", fontSize: 12, textAlign: "center", marginTop: 20 },

  table: { width: "100%", borderCollapse: "collapse", fontSize: 11 },
  row: { borderBottom: "1px solid #0f0f1a" },
  rowFlag: { background: "#1a100a" },

  opCell: { padding: "3px 8px", width: 80, verticalAlign: "middle" },
  pathCell: {
    padding: "3px 6px",
    color: "#9090b0",
    fontFamily: "monospace",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 200,
  },
  flagCell: {
    padding: "3px 6px",
    color: "#fbbf24",
    fontSize: 10,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },

  opBadge: {
    padding: "1px 5px",
    borderRadius: 3,
    fontSize: 10,
    fontWeight: 700,
    fontFamily: "monospace",
  },
  opRead: { background: "#0a1a0a", color: "#4ade80" },
  opWrite: { background: "#1a0a0a", color: "#f87171" },
  opReg: { background: "#1a1000", color: "#fbbf24" },

  detailCell: { padding: "0 10px 6px 10px", background: "#07070f" },
  detailPre: {
    fontSize: 10,
    color: "#706070",
    fontFamily: "monospace",
    margin: 0,
    overflowX: "auto",
  },
};
