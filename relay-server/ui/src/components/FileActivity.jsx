import React, { useEffect, useState, useCallback } from "react";
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
  const [tree, setTree] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set(["C:"]));
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState("");
  const [loadingPreviewPath, setLoadingPreviewPath] = useState("");
  const agentId = agent?.agentId;

  const fetchOps = useCallback(async () => {
    if (!agentId) return;
    try {
      const data = await api.getHistory(agentId);
      const calls = data?.tool_calls ?? [];
      const out = [];
      for (const call of calls) {
        const op = call.tool_name;
        if (!FILE_OPS.has(op) && !REG_OPS.has(op)) continue;

        let input = {};
        try {
          input = call.args_json ? JSON.parse(call.args_json) : {};
        } catch {
          input = {};
        }

        const path =
          input.path ||
          (input.hive && input.key
            ? `${input.hive}\\${input.key}${input.value_name ? `\\${input.value_name}` : ""}`
            : "—");

        out.push({
          id: call.id ?? Math.random().toString(36).slice(2),
          op,
          path,
          isReg: REG_OPS.has(op),
          isWrite: isWriteOp(op),
          input,
        });
      }
      setRows(out.slice(-200));
    } catch {
      /* polling: ignore */
    }
  }, [agentId]);

  const fetchTree = useCallback(async () => {
    if (!agentId) return;
    try {
      const data = await api.getFileActivityTree(agentId);
      setTree(data && data.children ? data : null);
    } catch {
      /* polling: ignore */
    }
  }, [agentId]);

  useEffect(() => {
    setRows([]);
    setTree(null);
    setExpanded(new Set(["C:"]));
    setPreview(null);
    setPreviewError("");
    setLoadingPreviewPath("");
    fetchOps();
    fetchTree();
    const t = setInterval(() => {
      fetchOps();
      fetchTree();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [fetchOps, fetchTree]);

  const toggleNode = useCallback((nodePath) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodePath)) next.delete(nodePath);
      else next.add(nodePath);
      return next;
    });
  }, []);

  const openPreview = useCallback(
    async (node) => {
      if (
        !agentId ||
        !node ||
        !node.file_location_id ||
        !node.has_cached_content
      )
        return;
      setPreviewError("");
      setLoadingPreviewPath(node.path);
      try {
        const data = await api.getFileActivityContent(
          agentId,
          node.file_location_id,
        );
        setPreview(data);
      } catch (err) {
        setPreviewError(err?.message || "Failed to load file content");
      } finally {
        setLoadingPreviewPath("");
      }
    },
    [agentId],
  );

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>File Activity</span>
        <span style={styles.count}>{rows.length} ops</span>
      </div>
      <div style={styles.mapWrap}>
        <div style={styles.mapHeader}>Directory Map</div>
        <div style={styles.mapScroll}>
          {!tree || !tree.children || tree.children.length === 0 ? (
            <p style={styles.emptyMap}>No directories discovered yet.</p>
          ) : (
            <div>
              <MapNode
                node={tree}
                depth={0}
                expanded={expanded}
                onToggle={toggleNode}
                onOpenFile={openPreview}
                loadingPreviewPath={loadingPreviewPath}
              />
            </div>
          )}
        </div>
      </div>
      <div style={styles.viewerWrap}>
        <div style={styles.viewerHeader}>File Viewer</div>
        {!preview && !previewError ? (
          <div style={styles.viewerEmpty}>
            Select a highlighted file (cached in DB) to open it.
          </div>
        ) : previewError ? (
          <div style={styles.viewerError}>{previewError}</div>
        ) : (
          <div style={styles.viewerBody}>
            <div style={styles.viewerMeta}>
              <span style={styles.viewerPath}>
                {preview?.path || "(unknown path)"}
              </span>
              <span style={styles.viewerStamp}>
                {preview?.updated_at
                  ? new Date(preview.updated_at).toLocaleString()
                  : "No timestamp"}
              </span>
            </div>
            <pre style={styles.viewerPre}>
              {preview?.content || "(no cached content)"}
            </pre>
          </div>
        )}
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

function MapNode({
  node,
  depth,
  expanded,
  onToggle,
  onOpenFile,
  loadingPreviewPath,
}) {
  const isDir = node.type === "directory";
  const rawChildren = Array.isArray(node.children) ? node.children : [];
  const children = rawChildren.slice().sort((a, b) => {
    const ad = a.type === "directory" ? 0 : 1;
    const bd = b.type === "directory" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, {
      sensitivity: "base",
    });
  });
  const isOpen = isDir ? expanded.has(node.path) : false;
  const prefix = isDir ? (isOpen ? "-" : "+") : "·";
  const cached = !!node.has_cached_content;
  const loading = loadingPreviewPath === node.path;

  return (
    <div>
      <div
        style={{
          ...styles.mapRow,
          paddingLeft: 8 + depth * 14,
          cursor: isDir ? "pointer" : cached ? "pointer" : "default",
          ...(cached ? styles.mapFileCached : {}),
        }}
        onClick={() => {
          if (isDir) {
            onToggle(node.path);
            return;
          }
          if (cached && !loading) onOpenFile(node);
        }}
        title={node.path}
      >
        <span style={styles.mapPrefix}>{prefix}</span>
        <span style={isDir ? styles.mapDir : styles.mapFile}>{node.name}</span>
        {!isDir && cached ? (
          <span style={styles.cacheBadge}>cached</span>
        ) : null}
        {!isDir && loading ? (
          <span style={styles.cacheLoading}>loading...</span>
        ) : null}
      </div>
      {isDir && isOpen ? (
        children.length > 0 ? (
          children.map((child) => (
            <MapNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              loadingPreviewPath={loadingPreviewPath}
            />
          ))
        ) : (
          <div
            style={{ ...styles.mapEmpty, paddingLeft: 8 + (depth + 1) * 14 }}
          >
            (empty)
          </div>
        )
      ) : null}
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
  mapWrap: {
    borderBottom: "1px solid #141426",
    background: "#090914",
  },
  mapHeader: {
    padding: "4px 10px",
    fontSize: 10,
    color: "#72729a",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    borderBottom: "1px solid #111122",
  },
  mapScroll: {
    maxHeight: 220,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "4px 0",
  },
  emptyMap: {
    color: "#3a3a5a",
    fontSize: 12,
    textAlign: "center",
    margin: "8px 0",
  },
  mapRow: {
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 1.5,
    color: "#96a0c4",
    userSelect: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  mapPrefix: {
    display: "inline-block",
    width: 12,
    color: "#8b94bb",
    fontWeight: 700,
    marginRight: 4,
  },
  mapDir: {
    color: "#9cb1ff",
    fontWeight: 700,
  },
  mapFile: {
    color: "#94a3b8",
  },
  mapFileCached: {
    color: "#b8f7c8",
  },
  cacheBadge: {
    marginLeft: 8,
    fontSize: 9,
    color: "#4ade80",
    border: "1px solid #1f5a35",
    borderRadius: 3,
    padding: "0 4px",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  cacheLoading: {
    marginLeft: 8,
    fontSize: 9,
    color: "#cbd5e1",
  },
  mapEmpty: {
    fontFamily: "monospace",
    fontSize: 10,
    color: "#5b6788",
    fontStyle: "italic",
    lineHeight: 1.4,
  },
  viewerWrap: {
    borderBottom: "1px solid #141426",
    background: "#080812",
  },
  viewerHeader: {
    padding: "4px 10px",
    fontSize: 10,
    color: "#7f88aa",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    borderBottom: "1px solid #111122",
  },
  viewerEmpty: {
    color: "#526089",
    fontSize: 11,
    padding: "8px 10px",
  },
  viewerError: {
    color: "#f87171",
    fontSize: 11,
    padding: "8px 10px",
  },
  viewerBody: {
    padding: "8px 10px",
    maxHeight: 180,
    overflow: "auto",
  },
  viewerMeta: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  viewerPath: {
    color: "#b8c2e8",
    fontSize: 10,
    fontFamily: "monospace",
    flex: 1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  viewerStamp: {
    color: "#6b7396",
    fontSize: 9,
    whiteSpace: "nowrap",
  },
  viewerPre: {
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    color: "#d6dbef",
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 1.4,
  },
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
