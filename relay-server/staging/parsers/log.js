"use strict";

/**
 * General log keyword extractor — fallback for unrecognised file types.
 * Extracts lines containing error/warning/failure keywords.
 * Returns matched lines with line numbers and ±2 lines of context.
 */

const MATCH_PATTERNS = ["*.log", "*.LOG", "*.txt", "*.TXT"];

const KEYWORDS = [
  "error",
  "fail",
  "failed",
  "failure",
  "fault",
  "crash",
  "exception",
  "warning",
  "warn",
  "critical",
  "corrupt",
  "invalid",
  "missing",
  "cannot",
  "can't",
  "unable",
  "denied",
  "refused",
  "timeout",
  "timed out",
  "not found",
  "undefined",
  "null pointer",
  "access violation",
];

const KEYWORD_RE = new RegExp(KEYWORDS.join("|"), "i");

const MAX_MATCHES = 50;

function parse(content) {
  const lines = content.split("\n");
  const matches = [];

  for (let i = 0; i < lines.length; i++) {
    if (KEYWORD_RE.test(lines[i])) {
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length - 1, i + 2);
      const ctx = [];
      for (let j = start; j <= end; j++) {
        ctx.push({ line_no: j + 1, text: lines[j], is_match: j === i });
      }
      matches.push({ line_no: i + 1, context: ctx });
      if (matches.length >= MAX_MATCHES) break;
    }
  }

  return {
    keyword_matches: matches,
    match_count: matches.length,
    truncated_at: matches.length >= MAX_MATCHES ? MAX_MATCHES : null,
    raw_size_bytes: content.length,
    lines_total: lines.length,
  };
}

module.exports = { MATCH_PATTERNS, parse };
