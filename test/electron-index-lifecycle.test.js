const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("the utility worker uses Electron's process parentPort API", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "..", "usage-history", "index-worker.js"),
    "utf8"
  );
  assert.match(source, /const \{ parentPort \} = process;/);
  assert.equal(source.includes('require("electron")'), false);
});

test("usage-index repair is wired from Diagnostics through preload IPC", async () => {
  const [main, preload, history] = await Promise.all([
    fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "preload.js"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "public", "history.js"), "utf8")
  ]);

  assert.match(main, /ipcMain\.handle\("usage-history:repair"/);
  assert.match(main, /forceRebuild: true/);
  assert.match(preload, /repairUsageHistory:.*usage-history:repair/);
  assert.match(history, /nativeApi\.repairUsageHistory\(\{ rangeDays \}\)/);
});
