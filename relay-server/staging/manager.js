"use strict";

/**
 * File staging manager.
 *
 * Responsibilities:
 * - Maintain a staging directory per session
 * - Pull files from Win98 in 32KB chunks and reassemble locally
 * - Select and run the appropriate parser for each staged file
 * - Return parsed/extracted content for inclusion in LLM context
 */

const fs = require("fs");
const path = require("path");

const CHUNK_SIZE = 32768; // 32KB — matches Win98 server max chunk size
const CONTEXT_BUDGET_BYTES = 256 * 1024;

const TEXT_EXTENSIONS = new Set([
  "txt",
  "ini",
  "cfg",
  "log",
  "bat",
  "cmd",
  "inf",
  "reg",
  "c",
  "h",
  "cpp",
  "asm",
  "js",
  "json",
  "md",
  "xml",
  "html",
  "htm",
]);

function getExtension(filePath) {
  return path
    .extname(String(filePath || ""))
    .replace(/^\./, "")
    .toLowerCase();
}

function mimeTypeFromPath(filePath) {
  const ext = getExtension(filePath);
  switch (ext) {
    case "txt":
    case "ini":
    case "cfg":
    case "log":
    case "bat":
    case "cmd":
    case "reg":
    case "c":
    case "h":
    case "cpp":
    case "asm":
    case "js":
    case "json":
    case "md":
    case "xml":
    case "html":
    case "htm":
      return "text/plain";
    case "bmp":
      return "image/bmp";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function decodeTextBuffer(buffer) {
  if (!buffer || buffer.length === 0) return "";

  const utf8 = buffer.toString("utf8");
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
  if (replacementCount > Math.max(3, Math.floor(utf8.length * 0.02))) {
    return buffer.toString("latin1");
  }

  return utf8;
}

// ── Parser registry ───────────────────────────────────────────────────────────

const BUILT_IN_PARSERS = [
  require("./parsers/drwatson"),
  require("./parsers/registry"),
  require("./parsers/msd"),
  require("./parsers/gcc"),
  require("./parsers/bootlog"),
  require("./parsers/ini"),
  require("./parsers/log"), // fallback — must be last
];

let allParsers = [...BUILT_IN_PARSERS];

/**
 * Load custom parsers from the parsers/custom/ directory at startup.
 */
function loadCustomParsers(stagingDir) {
  const customDir = path.join(__dirname, "parsers", "custom");
  if (!fs.existsSync(customDir)) return;

  for (const file of fs.readdirSync(customDir)) {
    if (!file.endsWith(".js")) continue;
    try {
      const parser = require(path.join(customDir, file));
      if (parser.MATCH_PATTERNS && typeof parser.parse === "function") {
        // Insert before the generic log fallback
        allParsers.splice(allParsers.length - 1, 0, parser);
        console.log(`[staging] Loaded custom parser: ${file}`);
      }
    } catch (err) {
      console.error(
        `[staging] Failed to load custom parser ${file}:`,
        err.message,
      );
    }
  }
}

/**
 * Find the best parser for a filename.
 * Returns the last registered parser that matches (generic log is last).
 */
function findParser(filename) {
  const name = path.basename(filename).toUpperCase();

  for (let i = 0; i < allParsers.length - 1; i++) {
    const p = allParsers[i];
    for (const pattern of p.MATCH_PATTERNS) {
      const re = new RegExp(
        "^" +
          pattern.toUpperCase().replace(/\./g, "\\.").replace(/\*/g, ".*") +
          "$",
      );
      if (re.test(name)) return p;
    }
  }

  // Generic log fallback
  return allParsers[allParsers.length - 1];
}

// ── Session staging directories ───────────────────────────────────────────────

class StagingManager {
  constructor(baseDir, win98Client, logger) {
    this.baseDir = baseDir;
    this.win98 = win98Client;
    this.log = logger;
    this._ensureDir(baseDir);
    loadCustomParsers(baseDir);
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  sessionDir(sessionId) {
    const d = path.join(this.baseDir, `session_${sessionId}`);
    this._ensureDir(d);
    return d;
  }

  /**
   * Pull a file from Win98 in chunks, reassemble locally, and parse it.
   *
   * @param {string} sessionId
   * @param {string} win98Path  Absolute path on Win98 machine
   * @returns {object}          { staged_path, parsed, truncated_at_bytes }
   */
  async stageAndParse(sessionId, win98Path) {
    const dir = this.sessionDir(sessionId);
    const safeName = win98Path.replace(/[:\\\/]/g, "_").replace(/^_+/, "");
    const stagedPath = path.join(dir, safeName);

    let info;
    try {
      info = await this.win98.callTool("get_file_info", { path: win98Path });
    } catch (err) {
      return { error: `get_file_info failed: ${err.message}` };
    }

    if (!info || info.error) {
      return {
        error: info && info.error ? info.error : "get_file_info failed",
      };
    }

    if (!info.exists) {
      return { error: `File not found on Win98: ${win98Path}` };
    }

    const totalSize = Number(info.size_bytes ?? info.size ?? 0);
    this.log.debug(
      { path: win98Path, size: totalSize },
      "Staging file from Win98",
    );

    let offset = 0;
    const buffers = [];
    let truncatedAt = null;
    let reachedEof = false;

    while (!reachedEof && (totalSize === 0 || offset < totalSize)) {
      let result;
      try {
        result = await this.win98.callTool("read_file", {
          path: win98Path,
          offset,
          length: CHUNK_SIZE,
        });
      } catch (err) {
        this.log.warn({ err: err.message, offset }, "Chunk read failed");
        break;
      }

      if (!result || result.error) {
        this.log.warn(
          { offset, error: result && result.error },
          "Chunk read returned an error payload",
        );
        break;
      }

      let chunkBuffer = Buffer.alloc(0);
      if (typeof result.data_b64 === "string") {
        chunkBuffer = Buffer.from(result.data_b64, "base64");
      } else if (typeof result.content === "string") {
        chunkBuffer = Buffer.from(result.content, "utf8");
      }

      if (chunkBuffer.length > 0) {
        buffers.push(chunkBuffer);
      }

      const bytesRead = Number(
        result.bytes_read ?? result.length ?? chunkBuffer.length ?? 0,
      );
      if (bytesRead <= 0 && chunkBuffer.length === 0) break;

      offset += bytesRead > 0 ? bytesRead : chunkBuffer.length;
      reachedEof = result.eof === true || result.eof === 1;

      if (!reachedEof && offset >= CONTEXT_BUDGET_BYTES) {
        truncatedAt = offset;
        this.log.info(
          { path: win98Path, offset },
          "File truncated at context budget limit",
        );
        break;
      }
    }

    const fullBuffer = Buffer.concat(buffers);
    fs.writeFileSync(stagedPath, fullBuffer);

    const mimeType = mimeTypeFromPath(win98Path);
    const isTextFile = TEXT_EXTENSIONS.has(getExtension(win98Path));

    let parsed;
    let fullContent = null;

    if (isTextFile) {
      fullContent = decodeTextBuffer(fullBuffer);
      const parser = findParser(win98Path);
      try {
        parsed = parser.parse(fullContent);
      } catch (err) {
        this.log.warn(
          { err: err.message, path: win98Path },
          "Parser threw error — returning raw summary",
        );
        parsed = { error: err.message, raw_snippet: fullContent.slice(0, 500) };
      }
    } else {
      parsed = {
        binary: true,
        mime_type: mimeType,
        byte_length: fullBuffer.length,
        note: "Binary file staged locally; raw bytes were omitted from model context.",
      };
    }

    return {
      win98_path: win98Path,
      staged_path: stagedPath,
      file_size: totalSize,
      staged_bytes: fullBuffer.length,
      truncated_at_bytes: truncatedAt,
      mime_type: mimeType,
      is_text: isTextFile,
      content: fullContent,
      parsed,
    };
  }

  /**
   * Clean up all staged files for a session.
   */
  cleanSession(sessionId) {
    const dir = path.join(this.baseDir, `session_${sessionId}`);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

module.exports = StagingManager;
