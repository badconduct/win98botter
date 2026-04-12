"use strict";

/**
 * BOOTLOG.TXT parser.
 * Extracts failed driver loads and IOS load failures from C:\BOOTLOG.TXT.
 */

const MATCH_PATTERNS = [
  "BOOTLOG.TXT",
  "bootlog.txt",
  "BOOTLOG.PRV",
  "bootlog.prv",
];

function parse(content) {
  const lines = content.split("\n");
  const failures = [];
  const successes = [];
  const iosFailures = [];

  for (const raw of lines) {
    const line = raw.trim();

    // LoadFailed lines
    if (/^LoadFailed\s*=/i.test(line)) {
      const m = line.match(/^LoadFailed\s*=\s*(.+)$/i);
      if (m) failures.push(m[1].trim());
      continue;
    }

    // IOS (I/O Supervisor) failures
    if (/^IOS\s+failed/i.test(line) || /^IOS_failure/i.test(line)) {
      iosFailures.push(line);
      continue;
    }

    // Dynamic load failures
    if (/^DynaLink Failure/i.test(line)) {
      iosFailures.push(line);
      continue;
    }

    // LoadSuccess lines (for context)
    if (/^LoadSuccess\s*=/i.test(line)) {
      const m = line.match(/^LoadSuccess\s*=\s*(.+)$/i);
      if (m) successes.push(m[1].trim());
      continue;
    }
  }

  return {
    failed_drivers: failures,
    failure_count: failures.length,
    ios_failures: iosFailures,
    loaded_ok_count: successes.length,
    raw_size_bytes: content.length,
    lines_total: lines.length,
  };
}

module.exports = { MATCH_PATTERNS, parse };
