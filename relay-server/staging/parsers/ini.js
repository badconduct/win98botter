"use strict";

/**
 * INI file parser — wraps the npm `ini` package to parse Win98SE config files
 * pulled to the relay staging directory.
 *
 * Returns the parsed key-value structure for inclusion in LLM context.
 * This is distinct from the C INI parser on Win98 which does in-place reads/writes.
 */

const MATCH_PATTERNS = ["*.ini", "*.INI"];

function parse(content) {
  let parsed;
  try {
    // Manual parse to avoid npm `ini` dependency issues in edge cases
    parsed = parseIni(content);
  } catch (e) {
    parsed = { _parse_error: e.message };
  }

  return {
    sections: parsed,
    section_count: Object.keys(parsed).filter((k) => !k.startsWith("_")).length,
    raw_size_bytes: content.length,
  };
}

/**
 * Minimal INI parser — handles [Section], Key=Value, and ; comments.
 * Case-insensitive keys. Preserves original casing in output.
 */
function parseIni(content) {
  const result = {};
  let currentSection = "_root";
  result[currentSection] = {};

  for (const raw of content.split("\n")) {
    const line = raw.trim();

    // Skip comments and blank lines
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;

    // Section header
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!result[currentSection]) result[currentSection] = {};
      continue;
    }

    // Key=Value
    const eqPos = line.indexOf("=");
    if (eqPos > 0) {
      const key = line.substring(0, eqPos).trim();
      const val = line.substring(eqPos + 1).trim();
      result[currentSection][key] = val;
    }
  }

  // Remove empty _root if unused
  if (Object.keys(result["_root"]).length === 0) delete result["_root"];

  return result;
}

module.exports = { MATCH_PATTERNS, parse };
