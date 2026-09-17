"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { restoreBackupWithCopy } = require("../routes/undo");

test("undo restores a recorded backup through the deployed copy_file tool", async () => {
  const calls = [];
  const win98 = {
    async callTool(name, input) {
      calls.push({ name, input });
      return { success: true };
    },
  };

  await restoreBackupWithCopy(
    win98,
    "C:\\WIN98BOTTER\\BACKUPS\\sample\\20260821_120000.bak",
    "C:\\WIN98BOTTER\\TESTS\\sample.txt",
  );

  assert.deepEqual(calls, [
    {
      name: "copy_file",
      input: {
        src: "C:\\WIN98BOTTER\\BACKUPS\\sample\\20260821_120000.bak",
        dst: "C:\\WIN98BOTTER\\TESTS\\sample.txt",
      },
    },
  ]);
});

test("undo rejects a failed native copy result", async () => {
  await assert.rejects(
    restoreBackupWithCopy(
      { callTool: async () => ({ success: false, win32_error: 5 }) },
      "backup.bak",
      "target.txt",
    ),
    /Backup restore copy failed: 5/,
  );
});
