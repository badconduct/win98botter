// Thin wrapper around fetch for all relay-server API calls.
// All functions return parsed JSON or throw on HTTP error.

async function request(method, url, body) {
  const opts = {
    method,
    headers: {},
  };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${url} → ${res.status}: ${text}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

export const api = {
  // Config
  checkConfig: () => request("GET", "/api/config/check"),
  getConfig: () => request("GET", "/api/config"),
  saveConfig: (body) => request("POST", "/api/config", body),
  testConfig: (body) => request("POST", "/api/config/test", body),

  // Agents
  listAgents: () => request("GET", "/api/agents"),
  getAgent: (id) => request("GET", `/api/agents/${encodeURIComponent(id)}`),
  removeAgent: (id) =>
    request("DELETE", `/api/agents/${encodeURIComponent(id)}`),

  // Chat
  sendChat: (body) => request("POST", "/chat", body),

  // History
  getHistory: (agentId, sessionId, source) => {
    const q = new URLSearchParams();
    if (agentId) q.set("agent_id", agentId);
    if (sessionId) q.set("session_id", sessionId);
    if (source) q.set("source", source);
    return request("GET", `/history?${q}`);
  },

  // System prompt
  getSystemPrompt: (agentId) => {
    const q = new URLSearchParams();
    if (agentId) q.set("agent_id", agentId);
    return request("GET", `/api/system-prompt?${q}`);
  },
  setSystemPromptFlags: (agentId, flags) =>
    request("POST", "/api/system-prompt/flags", {
      agent_id: agentId,
      flags,
    }),
  setAgentPermissions: (agentId, permissions) =>
    request("POST", "/control", {
      action: "permissions",
      agent_id: agentId,
      permissions,
    }),

  // Control
  control: (body) => request("POST", "/control", body),

  // Undo
  undo: (agentId) => request("POST", "/undo", { agent_id: agentId }),

  // Health
  health: () => request("GET", "/health"),

  // Phase 1 map cache
  cacheDirScan: (body) => request("POST", "/api/map/files/dir-scan", body),
  getCachedDir: (agentId, dirPath) => {
    const q = new URLSearchParams();
    q.set("agent_id", agentId);
    q.set("dir_path", dirPath);
    return request("GET", `/api/map/files?${q}`);
  },
  captureFileRead: (body) =>
    request("POST", "/api/map/files/read-capture", body),
  getFileReadCaptures: (agentId, filePath, limit) => {
    const q = new URLSearchParams();
    q.set("agent_id", agentId);
    q.set("file_path", filePath);
    if (limit) q.set("limit", String(limit));
    return request("GET", `/api/map/files/read-capture?${q}`);
  },
  // File activity directory map
  getFileActivityTree: (agentId) =>
    request("GET", `/api/file-activity/tree/${encodeURIComponent(agentId)}`),
  getFileActivityContent: (agentId, fileLocationId) =>
    request(
      "GET",
      `/api/file-activity/content/${encodeURIComponent(agentId)}/${encodeURIComponent(fileLocationId)}`,
    ),
  captureRegistry: (body) => request("POST", "/api/map/registry/capture", body),
  getCachedRegistry: (agentId, keyPath) => {
    const q = new URLSearchParams();
    q.set("agent_id", agentId);
    q.set("key_path", keyPath);
    return request("GET", `/api/map/registry?${q}`);
  },
};
