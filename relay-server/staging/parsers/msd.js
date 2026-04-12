"use strict";

/**
 * MSD.EXE output parser.
 * Extracts IRQ ownership table, DMA table, I/O port ranges, and memory usage.
 */

const MATCH_PATTERNS = ["msd*.txt", "MSD*.TXT", "msd_report.txt"];

function parse(content) {
  const lines = content.split("\n");
  const irqTable = [];
  const dmaTable = [];
  const ioPorts = [];

  let section = null;

  for (const raw of lines) {
    const line = raw.trim();

    // Section detection
    if (/IRQ\s+(Status|Summary|Usage)/i.test(line)) {
      section = "irq";
      continue;
    }
    if (/DMA\s+(Status|Summary|Usage)/i.test(line)) {
      section = "dma";
      continue;
    }
    if (/I\/O\s+Port\s+(Status|Address|Map)/i.test(line)) {
      section = "io";
      continue;
    }
    if (/^[A-Z][\w\s]+:$/.test(line) || line === "") {
      if (section) section = null;
      continue;
    }

    if (section === "irq") {
      // Lines like:  "  7  001C  Printer (LPT1)"
      //              "IRQ  Address   Description"
      const m = line.match(/^\s*(\d+)\s+([0-9A-Fa-f]{4})\s+(.+)$/);
      if (m) {
        irqTable.push({
          irq: parseInt(m[1], 10),
          address: m[2].toUpperCase(),
          owner: m[3].trim(),
        });
      }
    } else if (section === "dma") {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (m) {
        dmaTable.push({ channel: parseInt(m[1], 10), owner: m[2].trim() });
      }
    } else if (section === "io") {
      // "0378-037F  LPT1"
      const m = line.match(/^\s*([0-9A-Fa-f]{3,4}[-][0-9A-Fa-f]{3,4})\s+(.+)$/);
      if (m) {
        ioPorts.push({ range: m[1].toUpperCase(), owner: m[2].trim() });
      }
    }
  }

  return {
    irq_table: irqTable,
    dma_table: dmaTable,
    io_ports: ioPorts,
    raw_size_bytes: content.length,
  };
}

module.exports = { MATCH_PATTERNS, parse };
