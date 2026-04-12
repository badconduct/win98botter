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

    // First get file info
    let info;
    try {
      info = await this.win98.callTool("get_file_info", { path: win98Path });
    } catch (err) {
      return { error: `get_file_info failed: ${err.message}` };
    }

    if (!info.exists) {
      return { error: `File not found on Win98: ${win98Path}` };
    }

    const totalSize = info.size || 0;
    this.log.debug(
      { path: win98Path, size: totalSize },
      "Staging file from Win98",
    );

    // Pull in chunks
    let offset = 0;
    const chunks = [];
    let truncatedAt = null;
    const CONTEXT_BUDGET_BYTES = 256 * 1024; // 256KB raw limit per file

    while (offset < totalSize) {
      let result;
      try {
        result = await this.win98.callTool("read_file", {
          path: win98Path,
          offset,
          length: CHUNK_SIZE,
        });
      } catch (err) {
        this.log.warn({ err, offset }, "Chunk read failed");
        break;
      }

      const chunkContent = result.content || "";
      chunks.push(chunkContent);
      offset += result.bytes_read || chunkContent.length || CHUNK_SIZE;

      if (!result.truncated) break;

      if (offset >= CONTEXT_BUDGET_BYTES) {
        truncatedAt = offset;
        this.log.info(
          { path: win98Path, offset },
          "File truncated at context budget limit",
        );
        break;
      }
    }

    const fullContent = chunks.join("");

    // Write locally for parser
    fs.writeFileSync(stagedPath, fullContent, "utf8");

    // Parse
    const parser = findParser(win98Path);
    let parsed;
    try {
      parsed = parser.parse(fullContent);
    } catch (err) {
      this.log.warn(
        { err, path: win98Path },
        "Parser threw error — returning raw summary",
      );
      parsed = { error: err.message, raw_snippet: fullContent.slice(0, 500) };
    }

    return {
      win98_path: win98Path,
      staged_path: stagedPath,
      file_size: totalSize,
      staged_bytes: fullContent.length,
      truncated_at_bytes: truncatedAt,
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
