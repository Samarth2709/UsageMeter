const fs = require("node:fs/promises");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../server");

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("Claude sign-in launches directly with Google Chrome as its browser", async () => {
  const child = new EventEmitter();
  let unrefCalled = false;
  let stdinUnrefCalled = false;
  let invocation;
  child.unref = () => { unrefCalled = true; };
  child.stdin = { unref: () => { stdinUnrefCalled = true; } };

  const started = _test.startClaudeLoginInChrome((command, args, options) => {
    invocation = { command, args, options };
    process.nextTick(() => child.emit("spawn"));
    return child;
  }, 0);

  await started;

  assert.match(invocation.command, /claude$/);
  assert.deepEqual(invocation.args, ["auth", "login"]);
  assert.equal(invocation.options.env.BROWSER, chromePath);
  assert.equal(invocation.options.detached, true);
  assert.deepEqual(invocation.options.stdio, ["pipe", "ignore", "ignore"]);
  assert.equal(stdinUnrefCalled, true);
  assert.equal(unrefCalled, true);
  assert.equal(_test.getActiveClaudeLoginProcess(), child);
  child.emit("exit", 0, null);
  assert.equal(_test.getActiveClaudeLoginProcess(), null);
});

test("concurrent Claude sign-in requests reuse the active OAuth process", async () => {
  const child = new EventEmitter();
  child.stdin = { unref: () => {} };
  child.unref = () => {};
  let spawnCount = 0;
  const spawnCommand = () => {
    spawnCount += 1;
    process.nextTick(() => child.emit("spawn"));
    return child;
  };

  const first = _test.startClaudeLoginInChrome(spawnCommand, 0);
  const second = _test.startClaudeLoginInChrome(spawnCommand, 0);
  await Promise.all([first, second]);

  assert.equal(spawnCount, 1);
  child.emit("exit", 0, null);
});

test("Claude sign-in reports an inner CLI that exits during startup", async () => {
  const child = new EventEmitter();
  child.unref = () => {};

  const started = _test.startClaudeLoginInChrome(() => {
    process.nextTick(() => {
      child.emit("spawn");
      child.emit("exit", 1, null);
    });
    return child;
  }, 50);

  await assert.rejects(started, /exited before opening Google Chrome \(exit 1\)/);
});

test("Codex sign-in opens its device authorization page in Google Chrome", () => {
  const command = _test.codexLoginCommandForAccount({
    type: "codex",
    codeHome: "/tmp/Usage Meter Codex"
  });

  assert.match(command, /export CODEX_HOME='\/tmp\/Usage Meter Codex'/);
  assert.match(
    command,
    /\('\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome' 'https:\/\/auth\.openai\.com\/codex\/device' >\/dev\/null 2>&1 &\)/
  );
  assert.match(command, /'[^']*codex' login --device-auth$/);
  assert.equal(command.includes("export BROWSER="), false);
});

test("Electron delegates sign-in to the CLI path instead of an embedded browser", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");

  assert.equal(source.includes("showClaudeUsageLogin"), false);
  assert.equal(source.includes("claudeLoginWindow"), false);
  assert.match(source, /Sign in to Claude with Chrome/);
  assert.match(
    source,
    /ipcMain\.handle\("rate-limit:open-login",[\s\S]*?return openLoginForAccountById\(accountId\);/
  );
});
