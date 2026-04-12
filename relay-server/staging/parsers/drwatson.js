"use strict";

/**
 * Dr. Watson log parser (DRWATSON.LOG).
 * Extracts crash records, task list at crash time, and application errors.
 */

const MATCH_PATTERNS = ["DRWATSON.LOG", "drwatson.log", "watson.log"];

function parse(content) {
  const lines = content.split("\n");
  const crashRecords = [];
  const taskList = [];

  let inTaskList = false;
  let currentCrash = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Application exception marker
    const appMatch =
      line.match(/^Application exception occurred:\s*$/i) ||
      line.match(/^An application error has occurred/i);
    if (appMatch) {
      if (currentCrash) crashRecords.push(currentCrash);
      currentCrash = {
        app: null,
        app_path: null,
        timestamp: null,
        exception_code: null,
        exception_name: null,
        fault_module: null,
        fault_offset: null,
        registers: {},
      };
      // Look back for the app name on nearby lines
      for (let back = Math.max(0, i - 5); back < i; back++) {
        const bl = lines[back];
        const appPathMatch = bl.match(/App:\s+(.+\.exe)/i);
        if (appPathMatch) {
          currentCrash.app_path = appPathMatch[1].trim();
          currentCrash.app = currentCrash.app_path.split(/[\\\/]/).pop();
        }
        const tsMatch = bl.match(/(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d+)/);
        if (tsMatch) currentCrash.timestamp = tsMatch[1];
      }
      continue;
    }

    if (currentCrash) {
      // App: line
      const appLine = line.match(/^App:\s+(.+\.exe)/i);
      if (appLine) {
        currentCrash.app_path = appLine[1].trim();
        currentCrash.app = currentCrash.app_path.split(/[\\\/]/).pop();
      }

      // Exception code
      const excCode =
        line.match(/Exception number:\s*([\w]+)/i) ||
        line.match(/Exception code:\s*(0x[\da-fA-F]+)/i);
      if (excCode) {
        currentCrash.exception_code = excCode[1];
        if (excCode[1] === "0xC0000005" || excCode[1] === "c0000005") {
          currentCrash.exception_name = "ACCESS_VIOLATION";
        } else if (excCode[1] === "0xC0000094") {
          currentCrash.exception_name = "INTEGER_DIVIDE_BY_ZERO";
        } else if (excCode[1] === "0x80000003") {
          currentCrash.exception_name = "BREAKPOINT";
        }
      }

      // Fault at
      const faultLine = line.match(/Fault at:\s+(.+)\s+in\s+(.+)/i);
      if (faultLine) {
        currentCrash.fault_offset = faultLine[1].trim();
        currentCrash.fault_module = faultLine[2].trim();
      }
    }

    // Task list at time of crash
    if (
      /^-+ running tasks -+/i.test(line) ||
      /tasks running at time of error/i.test(line)
    ) {
      inTaskList = true;
      continue;
    }
    if (inTaskList) {
      if (line === "" || line.startsWith("-")) {
        inTaskList = false;
        continue;
      }
      const task = line.replace(/^\*\s*/, "").trim();
      if (task && !taskList.includes(task)) taskList.push(task);
    }
  }

  if (currentCrash) crashRecords.push(currentCrash);

  return {
    crash_records: crashRecords,
    crash_count: crashRecords.length,
    task_list_at_crash: taskList,
    raw_size_bytes: content.length,
    lines_total: lines.length,
  };
}

module.exports = { MATCH_PATTERNS, parse };
