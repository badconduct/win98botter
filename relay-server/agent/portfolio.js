"use strict";

const PORTFOLIOS = {
  general: {
    key: "general",
    label: "General",
    preferredTools: [
      "get_system_info",
      "list_processes",
      "read_clipboard",
      "get_window_list",
      "run_command",
    ],
    guidance:
      "Handle simple mixed requests pragmatically, prefer quick verification, and keep the reply concise.",
  },
  search: {
    key: "search",
    label: "Search / Discovery",
    preferredTools: [
      "file_exists",
      "get_file_info",
      "list_directory",
      "find_files",
      "grep_file",
      "read_registry",
      "list_registry",
    ],
    guidance:
      "Prioritize cache-first verification, likely Win98 folders, and focused file discovery before broad searches.",
  },
  code: {
    key: "code",
    label: "Code / Build",
    preferredTools: [
      "read_file",
      "write_file",
      "append_file",
      "run_command",
      "run_bat",
      "write_and_run_bat",
      "get_command_output",
    ],
    guidance:
      "Focus on source inspection, precise edits, builds, and compile output. Prefer file tools over shell hacks when editing text.",
  },
  troubleshoot: {
    key: "troubleshoot",
    label: "Troubleshooter",
    preferredTools: [
      "list_processes",
      "get_system_info",
      "get_disk_info",
      "grep_file",
      "read_file",
      "run_command",
      "get_window_list",
    ],
    guidance:
      "Gather evidence first, inspect runtime output and logs, and explain the likely cause from the verified results.",
  },
  system: {
    key: "system",
    label: "System / Ops",
    preferredTools: [
      "get_system_info",
      "get_disk_info",
      "list_processes",
      "read_clipboard",
      "get_audio_devices",
      "get_midi_devices",
      "get_window_list",
    ],
    guidance:
      "Prioritize machine state, devices, processes, windows, clipboard, storage, and other operational checks.",
  },
};

const ACTION_HINTS = [
  "find",
  "locate",
  "search",
  "look for",
  "where is",
  "where are",
  "edit",
  "modify",
  "change",
  "update",
  "patch",
  "rewrite",
  "compile",
  "build",
  "run",
  "launch",
  "execute",
  "report",
  "show",
  "list",
  "check",
  "inspect",
  "debug",
  "fix",
  "open",
  "read",
  "write",
  "copy",
  "move",
  "delete",
  "rename",
];

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function splitIntoAsks(userMessage) {
  const raw = normalizeText(userMessage);
  if (!raw) return [];

  let working = ` ${raw} `;

  working = working
    .replace(/\b(and then|then|after that|finally|next)\b/gi, " | ")
    .replace(/\s*[;]+\s*/g, " | ")
    .replace(/\s*\n+\s*/g, " | ")
    .replace(
      /,\s*(?=(find|locate|search|edit|modify|change|update|patch|rewrite|compile|build|run|launch|report|show|list|check|inspect|debug|fix|open|read|write|copy|move|delete|rename)\b)/gi,
      " | ",
    )
    .replace(
      /\band\s+(?=(compile|build|run|launch|report|debug|inspect|check|show|list|edit|modify|change|update|patch|rewrite)\b)/gi,
      " | ",
    );

  const pieces = working
    .split("|")
    .map((part) => normalizeText(part))
    .filter(Boolean);

  const actionable = pieces.filter((piece) =>
    ACTION_HINTS.some((hint) => piece.toLowerCase().includes(hint)),
  );

  return actionable.length > 0 ? actionable : [raw];
}

function classifyPortfolio(askText) {
  const text = normalizeText(askText).toLowerCase();

  if (!text) return "general";

  if (
    /\b(edit|modify|change|update|patch|rewrite|write|compile|build|msdev|vc6|visual studio|dos tools|makefile|source|header|project)\b/.test(
      text,
    )
  ) {
    return "code";
  }

  if (
    /\b(crash|error|bug|broken|hang|freeze|frozen|won't start|cannot start|debug|diagnose|troubleshoot|failure|report the error|error message|when running)\b/.test(
      text,
    )
  ) {
    return "troubleshoot";
  }

  if (
    /\b(find|locate|search|where is|where are|path|folder|directory|install|installed|file|files|pdf|exe|dll|grep)\b/.test(
      text,
    )
  ) {
    return "search";
  }

  if (
    /\b(process|disk|memory|ram|clipboard|window|audio|midi|device|screen|resolution|storage|system info|free space)\b/.test(
      text,
    )
  ) {
    return "system";
  }

  return "general";
}

function buildPortfolioPlan(userMessage, allowedToolNames) {
  const asks = splitIntoAsks(userMessage);
  const allowed = new Set(allowedToolNames || []);

  const askItems = asks.map((askText, index) => {
    const portfolioKey = classifyPortfolio(askText);
    const meta = PORTFOLIOS[portfolioKey] || PORTFOLIOS.general;
    const prioritizedTools = meta.preferredTools.filter((name) =>
      allowed.has(name),
    );

    return {
      id: index + 1,
      text: askText,
      portfolio: portfolioKey,
      label: meta.label,
      prioritizedTools,
      guidance: meta.guidance,
    };
  });

  const primaryKey = askItems[0] ? askItems[0].portfolio : "general";
  const primaryMeta = PORTFOLIOS[primaryKey] || PORTFOLIOS.general;

  return {
    askCount: askItems.length || 1,
    primaryPortfolio: primaryKey,
    primaryLabel: primaryMeta.label,
    asks: askItems,
  };
}

module.exports = {
  PORTFOLIOS,
  splitIntoAsks,
  classifyPortfolio,
  buildPortfolioPlan,
};
