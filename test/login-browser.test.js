const fs = require("node:fs/promises");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

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

test("successful Claude sign-in completion notifies the app refresh listener", async () => {
  const child = new EventEmitter();
  let completionCount = 0;
  child.stdin = { unref: () => {} };
  child.unref = () => {};
  const unsubscribe = _test.onClaudeLoginCompleted(() => {
    completionCount += 1;
  });

  const started = _test.startClaudeLoginInChrome(() => {
    process.nextTick(() => child.emit("spawn"));
    return child;
  }, 0);

  await started;
  assert.equal(completionCount, 0);
  child.emit("exit", 0, null);
  assert.equal(completionCount, 1);
  unsubscribe();
});

test("quick successful Claude sign-in completion resolves startup and notifies once", async () => {
  const child = new EventEmitter();
  let completionCount = 0;
  child.stdin = { unref: () => {} };
  child.unref = () => {};
  const unsubscribe = _test.onClaudeLoginCompleted(() => {
    completionCount += 1;
  });

  const started = _test.startClaudeLoginInChrome(() => {
    process.nextTick(() => {
      child.emit("spawn");
      child.emit("exit", 0, null);
    });
    return child;
  }, 50);

  await started;
  assert.equal(completionCount, 1);
  assert.equal(_test.getActiveClaudeLoginProcess(), null);
  unsubscribe();
});

test("failed Claude sign-in completion does not notify the app refresh listener", async () => {
  const child = new EventEmitter();
  let completionCount = 0;
  child.stdin = { unref: () => {} };
  child.unref = () => {};
  const unsubscribe = _test.onClaudeLoginCompleted(() => {
    completionCount += 1;
  });

  const started = _test.startClaudeLoginInChrome(() => {
    process.nextTick(() => child.emit("spawn"));
    return child;
  }, 0);

  await started;
  child.emit("exit", 1, null);
  assert.equal(completionCount, 0);
  unsubscribe();
});

test("concurrent Claude sign-in requests reuse the process while it starts", async () => {
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

test("a later Claude sign-in click replaces the active OAuth process", async () => {
  const children = [new EventEmitter(), new EventEmitter()];
  let spawnCount = 0;
  let firstStdinEnded = false;
  const events = [];

  for (const [index, child] of children.entries()) {
    child.stdin = {
      unref: () => {},
      end: () => { if (index === 0) firstStdinEnded = true; }
    };
    child.unref = () => {};
    child.kill = (signal) => {
      events.push(`kill:${index}:${signal}`);
      if (index === 0 && signal === "SIGKILL") {
        events.push("exit:0");
        child.emit("exit", null, signal);
      }
      return true;
    };
  }

  const spawnCommand = () => {
    const child = children[spawnCount];
    events.push(`spawn:${spawnCount}`);
    spawnCount += 1;
    process.nextTick(() => child.emit("spawn"));
    return child;
  };

  await _test.startClaudeLoginInChrome(spawnCommand, 0);
  await _test.startClaudeLoginInChrome(spawnCommand, 0, 0);

  assert.equal(spawnCount, 2);
  assert.equal(firstStdinEnded, true);
  assert.deepEqual(events, [
    "spawn:0",
    "kill:0:SIGTERM",
    "kill:0:SIGKILL",
    "exit:0",
    "spawn:1"
  ]);
  assert.equal(_test.getActiveClaudeLoginProcess(), children[1]);
  children[1].emit("exit", 0, null);
});

test("a replaced Claude sign-in cannot report a clean exit as completion", async () => {
  const children = [new EventEmitter(), new EventEmitter()];
  let spawnCount = 0;
  let completionCount = 0;

  for (const [index, child] of children.entries()) {
    child.stdin = { unref: () => {}, end: () => {} };
    child.unref = () => {};
    child.kill = () => {
      if (index === 0) child.emit("exit", 0, null);
      return true;
    };
  }

  const unsubscribe = _test.onClaudeLoginCompleted(() => {
    completionCount += 1;
  });
  const spawnCommand = () => {
    const child = children[spawnCount];
    spawnCount += 1;
    process.nextTick(() => child.emit("spawn"));
    return child;
  };

  await _test.startClaudeLoginInChrome(spawnCommand, 0);
  await _test.startClaudeLoginInChrome(spawnCommand, 0, 0);

  assert.equal(spawnCount, 2);
  assert.equal(completionCount, 0);
  unsubscribe();
  children[1].emit("exit", 0, null);
});

test("overlapping Claude sign-in restarts share one replacement process", async () => {
  const children = [new EventEmitter(), new EventEmitter()];
  let spawnCount = 0;

  for (const child of children) {
    child.stdin = { unref: () => {}, end: () => {} };
    child.unref = () => {};
    child.kill = () => true;
  }

  const spawnCommand = () => {
    const child = children[spawnCount];
    spawnCount += 1;
    process.nextTick(() => child.emit("spawn"));
    return child;
  };

  await _test.startClaudeLoginInChrome(spawnCommand, 0);
  const firstRestart = _test.startClaudeLoginInChrome(spawnCommand, 0, 50);
  const secondRestart = _test.startClaudeLoginInChrome(spawnCommand, 0, 50);

  assert.equal(spawnCount, 1);
  children[0].emit("exit", null, "SIGTERM");
  await Promise.all([firstRestart, secondRestart]);

  assert.equal(spawnCount, 2);
  assert.equal(_test.getActiveClaudeLoginProcess(), children[1]);
  children[1].emit("exit", 0, null);
});

test("Claude sign-in does not replace a process whose exit cannot be confirmed", async () => {
  const child = new EventEmitter();
  const signals = [];
  let spawnCount = 0;
  child.stdin = { unref: () => {}, end: () => {} };
  child.unref = () => {};
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };

  const spawnCommand = () => {
    spawnCount += 1;
    process.nextTick(() => child.emit("spawn"));
    return child;
  };

  await _test.startClaudeLoginInChrome(spawnCommand, 0);
  await assert.rejects(
    _test.startClaudeLoginInChrome(spawnCommand, 0, 0),
    /previous Claude sign-in could not be stopped/
  );

  assert.equal(spawnCount, 1);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(_test.getActiveClaudeLoginProcess(), child);
  child.emit("exit", null, "SIGKILL");
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
    /onClaudeLoginCompleted\(\(\) => \{[\s\S]*?refreshSnapshot\(\{ forceClaudeWebUsage: true \}\)/
  );
  assert.match(source, /startClaudeLoginCompletionRefresh\(\);[\s\S]*?registerIpcHandlers\(\);/);
  assert.match(
    source,
    /ipcMain\.handle\("rate-limit:open-login",[\s\S]*?return openLoginForAccountById\(accountId\);/
  );
});

test("Electron registers one behavioral forced refresh for Claude login completion", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");
  const start = source.indexOf("function startClaudeLoginCompletionRefresh(");
  const end = source.indexOf("function registerIpcHandlers(", start);
  assert.ok(start >= 0 && end > start, "completion refresh registration must be present");

  let completionListener = null;
  let unsubscribeCount = 0;
  const refreshCalls = [];
  const context = {
    stopClaudeLoginCompletionRefresh: null,
    onClaudeLoginCompleted(listener) {
      completionListener = listener;
      return () => {
        completionListener = null;
        unsubscribeCount += 1;
      };
    },
    refreshSnapshot(options) {
      refreshCalls.push(options);
      return Promise.resolve();
    },
    console: { warn: () => {} }
  };

  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.startClaudeLoginCompletionRefresh = startClaudeLoginCompletionRefresh;`,
    context
  );

  context.startClaudeLoginCompletionRefresh();
  context.startClaudeLoginCompletionRefresh();
  assert.equal(typeof completionListener, "function");
  completionListener();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].forceClaudeWebUsage, true);
  context.stopClaudeLoginCompletionRefresh();
  assert.equal(unsubscribeCount, 1);
  assert.equal(completionListener, null);
});
