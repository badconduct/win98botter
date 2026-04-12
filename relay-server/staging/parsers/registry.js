"use strict";

/**
 * Windows Registry export parser (.REG files).
 * Strips GUIDs, binary blobs, and CLSIDs.
 * Extracts only human-readable key names and string values.
 */

const MATCH_PATTERNS = ["*.reg", "*.REG"];

function isGuid(str) {
  return /^\{[0-9a-fA-F-]{36}\}$/.test(str.trim());
}

function parse(content) {
  const lines = content.split("\n");
  const keys = [];
  let currentKey = null;
  let skipped = 0;

  for (const raw of lines) {
    const line = raw.trim();

    // Registry key header: [HKEY_LOCAL_MACHINE\Software\...]
    const keyMatch = line.match(/^\[(.+)\]$/);
    if (keyMatch) {
      const keyPath = keyMatch[1];
      // Skip keys that are entirely CLSID/GUID subtrees
      if (isGuid(keyPath.split("\\").pop())) {
        currentKey = null;
        skipped++;
        continue;
      }
      currentKey = { key: keyPath, values: {} };
      keys.push(currentKey);
      continue;
    }

    if (!currentKey) continue;

    // String value: "ValueName"="data"
    const strMatch = line.match(/^"([^"]+)"="([^"]*)"$/);
    if (strMatch) {
      currentKey.values[strMatch[1]] = strMatch[2];
      continue;
    }

    // Default value: @="data"
    const defaultMatch = line.match(/^@="([^"]*)"$/);
    if (defaultMatch) {
      currentKey.values["(Default)"] = defaultMatch[1];
      continue;
    }

    // DWORD: "Name"=dword:00000001
    const dwordMatch = line.match(/^"([^"]+)"=dword:([0-9a-fA-F]+)/);
    if (dwordMatch) {
      currentKey.values[dwordMatch[1]] = `dword:${parseInt(dwordMatch[2], 16)}`;
      continue;
    }

    // Skip binary, hex, and multi-string values as unreadable
    if (
      line.startsWith('"') &&
      (line.includes("=hex:") ||
        line.includes("=hex(") ||
        line.includes("=binary:"))
    ) {
      skipped++;
    }
  }

  // Remove empty key entries
  const readableKeys = keys.filter((k) => Object.keys(k.values).length > 0);

  return {
    keys: readableKeys,
    key_count: readableKeys.length,
    skipped_binary_or_guid: skipped,
    raw_size_bytes: content.length,
  };
}

module.exports = { MATCH_PATTERNS, parse };
