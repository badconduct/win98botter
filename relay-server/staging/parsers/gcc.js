"use strict";

/**
 * GCC / MinGW compiler error parser.
 * Extracts structured errors from GCC stderr output.
 * The relay uses this to present compile errors cleanly to the LLM
 * without flooding context with raw compiler output.
 */

const MATCH_PATTERNS = [
  "compile_errors.txt",
  "gcc_output.txt",
  "make_output.txt",
  "*.gcc.txt",
];

function parse(content) {
  const lines = content.split("\n");
  const errors = [];
  const errorsByFile = {};
  let noteCount = 0;

  // GCC error format: filename:line:col: severity: message
  const GCC_PATTERN =
    /^(.+?):(\d+):(\d+):\s+(error|warning|note|fatal error):\s+(.+)$/;

  for (const raw of lines) {
    const m = raw.match(GCC_PATTERN);
    if (!m) continue;

    const [, file, lineStr, colStr, severity, message] = m;
    const lineNum = parseInt(lineStr, 10);
    const colNum = parseInt(colStr, 10);

    if (severity === "note") {
      noteCount++;
      continue;
    }

    const entry = {
      file,
      line: lineNum,
      col: colNum,
      severity,
      message: message.trim(),
    };
    errors.push(entry);

    if (!errorsByFile[file]) errorsByFile[file] = [];
    errorsByFile[file].push(entry);
  }

  // Count unique (file,line) pairs for error deduplication
  const uniqueLocations = new Set(errors.map((e) => `${e.file}:${e.line}`))
    .size;

  // Extract first N unique error files
  const affectedFiles = Object.keys(errorsByFile);

  return {
    errors,
    error_count: errors.filter(
      (e) => e.severity === "error" || e.severity === "fatal error",
    ).length,
    warning_count: errors.filter((e) => e.severity === "warning").length,
    note_count: noteCount,
    unique_locations: uniqueLocations,
    affected_files: affectedFiles,
    raw_size_bytes: content.length,
  };
}

module.exports = { MATCH_PATTERNS, parse };
