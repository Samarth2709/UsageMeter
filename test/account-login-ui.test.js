const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

function classList() {
  const values = new Set();
  return {
    values,
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    toggle(name, force) {
      if (force) values.add(name);
      else values.delete(name);
    }
  };
}

test("healthy accounts hide the redundant overall status message", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const start = source.indexOf("function setOverallStatus(");
  const end = source.indexOf("function updateAccountState(");
  const statusAnchor = { classList: classList() };
  const statusText = { textContent: "Waiting" };
  const statusDot = {
    className: "",
    title: "",
    setAttribute() {}
  };
  const accountStates = new Map([
    ["claude-1", { kind: "ok" }],
    ["codex-1", { kind: "ok" }]
  ]);
  const context = {
    overallStatus: statusDot,
    overallStatusText: statusText,
    overallStatusAnchor: statusAnchor,
    state: {
      config: {
        accounts: [
          { id: "claude-1" },
          { id: "codex-1" }
        ]
      }
    },
    accountStates,
    buildAccountName: () => "Account",
    lastSnapshotAt: 0
  };

  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.syncOverallStatus = syncOverallStatus;`,
    context
  );

  context.syncOverallStatus();
  assert.equal(statusAnchor.classList.values.has("hidden"), true);
  assert.equal(statusText.textContent, "");

  accountStates.set("claude-1", { kind: "disconnected" });
  context.syncOverallStatus();
  assert.equal(statusAnchor.classList.values.has("hidden"), false);
  assert.equal(statusText.textContent, "Some accounts need attention");
});

test("stale usage is hidden behind a minimal sign-in or retry action", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const start = source.indexOf("function renderConnected(");
  const end = source.indexOf("function renderResult(");
  assert.ok(start >= 0 && end > start, "connected account renderer must be present");

  const elements = {
    limitGrid: {
      children: [],
      classList: classList(),
      replaceChildren(...children) {
        this.children = children;
      }
    },
    summary: { textContent: "", title: "", className: "" },
    row: { classList: classList() },
    actions: { classList: classList() },
    connectButton: {
      classList: classList(),
      dataset: {},
      textContent: "",
      title: ""
    },
    deleteButton: {
      classList: classList(),
      textContent: "Delete",
      title: ""
    }
  };
  let accountType = "claude";
  let renderedWindows = 0;
  let latestState = null;
  const context = {
    accountElements: new Map([["claude-1", elements]]),
    rowsExpanded: true,
    getAccount: () => ({ type: accountType }),
    buildSummary: () => "5h 100%",
    renderLimitWindows(target) {
      renderedWindows += 1;
      target.limitGrid.classList.remove("hidden");
      target.limitGrid.replaceChildren({ textContent: "100%" });
    },
    buildResetTitle: () => "reset detail",
    isLoginNeededError: (error) => /not logged in|claude auth status --json/i.test(error || ""),
    showStatusSummary(target, text, className, title = "") {
      target.limitGrid.replaceChildren();
      target.limitGrid.classList.add("hidden");
      target.summary.textContent = text;
      target.summary.className = `account-summary ${className}`;
      target.summary.title = title;
    },
    updateAccountState(accountId, next) {
      latestState = {
        ...(latestState || {}),
        ...next,
        data: next.data !== undefined ? next.data : latestState?.data
      };
    }
  };

  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.renderConnected = renderConnected;`,
    context
  );

  const freshUsage = { windows: [{ remainingPercent: 100 }] };
  context.renderConnected("claude-1", freshUsage, { stale: false });
  assert.equal(renderedWindows, 1);
  assert.equal(elements.limitGrid.children.length, 1);
  assert.equal(latestState.data, freshUsage);

  context.renderConnected("claude-1", freshUsage, {
    stale: true,
    error: "Claude is not logged in on this machine."
  });

  assert.equal(elements.summary.textContent, "");
  assert.equal(elements.summary.className, "account-summary hidden");
  assert.equal(elements.limitGrid.classList.values.has("hidden"), true);
  assert.equal(elements.connectButton.textContent, "Sign in");
  assert.equal(elements.connectButton.dataset.action, "login");
  assert.equal(elements.connectButton.classList.values.has("hidden"), false);
  assert.equal(elements.deleteButton.classList.values.has("hidden"), false);
  assert.equal(elements.deleteButton.title, "Delete this account from Usage Meter");
  assert.equal(renderedWindows, 1);
  assert.equal(elements.limitGrid.children.length, 0);
  assert.equal(latestState.data, null);
  assert.equal(latestState.kind, "disconnected");

  context.renderConnected("claude-1", freshUsage, {
    stale: true,
    error: "Command failed: /Users/example/.local/bin/claude auth status --json"
  });
  assert.equal(elements.connectButton.textContent, "Sign in");
  assert.equal(elements.deleteButton.classList.values.has("hidden"), false);
  assert.equal(latestState.kind, "disconnected");

  accountType = "codex";
  context.renderConnected("claude-1", freshUsage, { stale: false });
  assert.equal(elements.limitGrid.children.length, 1);
  context.renderConnected("claude-1", freshUsage, {
    stale: true,
    error: "Refresh timed out."
  });

  assert.match(elements.summary.textContent, /^Unavailable/);
  assert.equal(elements.connectButton.textContent, "Retry");
  assert.equal(elements.connectButton.classList.values.has("hidden"), false);
  assert.equal(elements.deleteButton.classList.values.has("hidden"), true);
  assert.equal(renderedWindows, 2);
  assert.equal(elements.limitGrid.children.length, 0);
  assert.equal(latestState.data, null);
  assert.equal(latestState.stale, false);
  assert.equal(latestState.error, "Refresh timed out.");

  context.renderDisconnected("claude-1");
  assert.equal(elements.connectButton.textContent, "Sign in");
  assert.equal(elements.connectButton.title, "Open sign-in in Google Chrome");

  context.renderDisconnected("claude-1", new Error("Google Chrome is required."));
  assert.equal(
    elements.summary.textContent,
    "Could not open sign-in · Google Chrome is required."
  );
  assert.equal(elements.summary.className, "account-summary error");
  assert.equal(elements.connectButton.textContent, "Sign in");
  assert.equal(elements.deleteButton.classList.values.has("hidden"), false);
  assert.equal(latestState.kind, "disconnected");
  assert.equal(latestState.error, "Google Chrome is required.");

  accountType = "claude";
  context.renderError("claude-1", "Refresh timed out.");
  assert.equal(elements.connectButton.textContent, "Retry");
  assert.equal(elements.connectButton.title, "Try refreshing usage again");
  assert.equal(elements.connectButton.dataset.action, "retry");
});

test("account login click returns to the minimal account actions", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const start = source.indexOf("function createAccountRow(");
  const end = source.indexOf("function renderCurrentRows(");
  assert.ok(start >= 0 && end > start, "account row factory must be present");

  async function clickLogin(type, loginError = null) {
    let clickHandler = null;
    let openedAccountId = null;
    let disconnectedError = null;
    const connectButton = {
      classList: classList(),
      dataset: { action: "login" },
      disabled: false,
      textContent: "Sign in",
      addEventListener(event, handler) {
        if (event === "click") clickHandler = handler;
      }
    };
    const deleteButton = {
      classList: classList(),
      disabled: false,
      textContent: "Delete",
      addEventListener() {}
    };
    const elements = {
      name: { textContent: "" },
      typeTag: { textContent: "" },
      limitGrid: { classList: classList() },
      summary: { textContent: "", className: "", title: "" },
      actions: { classList: classList() },
      connectButton,
      deleteButton
    };
    const node = {
      classList: classList(),
      querySelector(selector) {
        return {
          ".account-name": elements.name,
          ".account-type": elements.typeTag,
          ".limit-grid": elements.limitGrid,
          ".account-summary": elements.summary,
          ".account-actions": elements.actions,
          ".connect-button": elements.connectButton,
          ".delete-button": elements.deleteButton
        }[selector];
      }
    };
    const context = {
      accountTemplate: {
        content: {
          firstElementChild: {
            cloneNode: () => node
          }
        }
      },
      accountElements: new Map(),
      accountStates: new Map([[`${type}-1`, { kind: "disconnected" }]]),
      buildAccountName: () => "Account",
      showStatusSummary: () => {},
      refreshAll: async () => {},
      openAccountLogin: async (accountId) => {
        openedAccountId = accountId;
        if (loginError) throw loginError;
      },
      updateAccountState: () => {},
      renderConnected: () => {},
      renderDisconnected: (accountId, error) => {
        disconnectedError = error;
        connectButton.textContent = "Sign in";
      },
      confirmAccountRemoval: () => false,
      removeAccount: async () => ({ config: { accounts: [] } }),
      syncAccountsFromConfig: () => {}
    };

    vm.runInNewContext(
      `${source.slice(start, end)}\nthis.createAccountRow = createAccountRow;`,
      context
    );

    context.createAccountRow({ id: `${type}-1`, type, label: "Account" });
    assert.equal(typeof clickHandler, "function");
    await clickHandler();

    return { connectButton, openedAccountId, disconnectedError };
  }

  const claude = await clickLogin("claude");
  assert.equal(claude.openedAccountId, "claude-1");
  assert.equal(claude.connectButton.textContent, "Sign in");

  const codex = await clickLogin("codex");
  assert.equal(codex.openedAccountId, "codex-1");
  assert.equal(codex.connectButton.textContent, "Sign in");

  const failure = new Error("Google Chrome is required.");
  const failed = await clickLogin("claude", failure);
  assert.equal(failed.disconnectedError, failure);
  assert.equal(failed.connectButton.textContent, "Sign in");
});

test("account delete confirms, removes the account, and syncs the returned config", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const start = source.indexOf("function createAccountRow(");
  const end = source.indexOf("function renderCurrentRows(");
  let deleteHandler = null;
  let removedAccountId = null;
  let syncedConfig = null;
  const connectButton = {
    classList: classList(),
    dataset: { action: "login" },
    disabled: false,
    textContent: "Sign in",
    addEventListener() {}
  };
  const deleteButton = {
    classList: classList(),
    disabled: false,
    textContent: "Delete",
    addEventListener(event, handler) {
      if (event === "click") deleteHandler = handler;
    }
  };
  const elements = {
    name: { textContent: "" },
    typeTag: { textContent: "" },
    limitGrid: { classList: classList() },
    summary: { textContent: "", className: "", title: "" },
    actions: { classList: classList() },
    connectButton,
    deleteButton
  };
  const node = {
    classList: classList(),
    querySelector(selector) {
      return {
        ".account-name": elements.name,
        ".account-type": elements.typeTag,
        ".limit-grid": elements.limitGrid,
        ".account-summary": elements.summary,
        ".account-actions": elements.actions,
        ".connect-button": elements.connectButton,
        ".delete-button": elements.deleteButton
      }[selector];
    }
  };
  const nextConfig = { accounts: [] };
  const context = {
    accountTemplate: { content: { firstElementChild: { cloneNode: () => node } } },
    accountElements: new Map(),
    accountStates: new Map(),
    buildAccountName: () => "samarth@example.com",
    showStatusSummary: () => {},
    refreshAll: async () => {},
    openAccountLogin: async () => {},
    updateAccountState: () => {},
    renderDisconnected: () => {},
    renderError: () => {},
    confirmAccountRemoval: () => true,
    removeAccount: async (accountId) => {
      removedAccountId = accountId;
      return { config: nextConfig };
    },
    syncAccountsFromConfig: (config) => {
      syncedConfig = config;
    }
  };

  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.createAccountRow = createAccountRow;`,
    context
  );

  context.createAccountRow({ id: "claude-1", type: "claude", label: "Account" });
  assert.equal(typeof deleteHandler, "function");
  await deleteHandler();

  assert.equal(removedAccountId, "claude-1");
  assert.equal(syncedConfig, nextConfig);
});

test("right-click account menu routes logout, login removal, and row deletion", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const start = source.indexOf("function createAccountRow(");
  const end = source.indexOf("function renderCurrentRows(");

  async function runAction(action) {
    let contextMenuHandler = null;
    let deleteClicks = 0;
    const logoutCalls = [];
    let syncedConfig = null;
    let disconnectedId = null;
    const connectButton = {
      classList: classList(),
      dataset: { action: "login" },
      disabled: false,
      textContent: "Sign in",
      addEventListener() {}
    };
    const deleteButton = {
      classList: classList(),
      disabled: false,
      textContent: "Delete",
      addEventListener() {},
      click() { deleteClicks += 1; }
    };
    const elements = {
      name: { textContent: "" },
      typeTag: { textContent: "" },
      limitGrid: { classList: classList() },
      summary: { textContent: "", className: "", title: "" },
      actions: { classList: classList() },
      connectButton,
      deleteButton
    };
    const node = {
      classList: classList(),
      querySelector(selector) {
        return {
          ".account-name": elements.name,
          ".account-type": elements.typeTag,
          ".limit-grid": elements.limitGrid,
          ".account-summary": elements.summary,
          ".account-actions": elements.actions,
          ".connect-button": elements.connectButton,
          ".delete-button": elements.deleteButton
        }[selector];
      },
      addEventListener(event, handler) {
        if (event === "contextmenu") contextMenuHandler = handler;
      }
    };
    const nextConfig = { accounts: [{ id: "claude-1", type: "claude" }] };
    const context = {
      accountTemplate: { content: { firstElementChild: { cloneNode: () => node } } },
      accountElements: new Map(),
      accountStates: new Map(),
      nativeApi: { showAccountMenu: async () => action },
      buildAccountName: () => "samarth@example.com",
      showStatusSummary: () => {},
      refreshAll: async () => {},
      openAccountLogin: async () => {},
      logoutAccount: async (accountId, removeLogin) => {
        logoutCalls.push({ accountId, removeLogin });
        return { config: nextConfig };
      },
      updateAccountState: () => {},
      renderDisconnected: (accountId) => { disconnectedId = accountId; },
      renderError: () => {},
      confirmLoginRemoval: () => true,
      confirmAccountRemoval: () => true,
      removeAccount: async () => ({ config: { accounts: [] } }),
      syncAccountsFromConfig: (config) => { syncedConfig = config; }
    };

    vm.runInNewContext(
      `${source.slice(start, end)}\nthis.createAccountRow = createAccountRow;`,
      context
    );
    context.createAccountRow({ id: "claude-1", type: "claude", label: "Account" });
    assert.equal(typeof contextMenuHandler, "function");
    let prevented = false;
    await contextMenuHandler({ preventDefault: () => { prevented = true; } });

    return { prevented, deleteClicks, logoutCalls, syncedConfig, disconnectedId };
  }

  const logout = await runAction("logout");
  assert.equal(logout.prevented, true);
  assert.deepEqual(logout.logoutCalls, [{ accountId: "claude-1", removeLogin: false }]);
  assert.equal(logout.syncedConfig.accounts.length, 1);
  assert.equal(logout.disconnectedId, "claude-1");

  const removeLogin = await runAction("remove-login");
  assert.deepEqual(removeLogin.logoutCalls, [{ accountId: "claude-1", removeLogin: true }]);
  assert.equal(removeLogin.disconnectedId, "claude-1");

  const deleteRow = await runAction("delete-row");
  assert.equal(deleteRow.deleteClicks, 1);
  assert.deepEqual(deleteRow.logoutCalls, []);
});

test("Electron exposes the native three-action account context menu", async () => {
  const [main, preload, styles] = await Promise.all([
    fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "preload.js"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "public", "styles.css"), "utf8")
  ]);

  assert.match(main, /label: "Log Out"/);
  assert.match(main, /label: "Log Out & Remove Login"/);
  assert.match(main, /label: "Delete Row"/);
  assert.match(main, /ipcMain\.handle\("rate-limit:show-account-menu"/);
  assert.match(main, /ipcMain\.handle\("rate-limit:logout-account"/);
  assert.match(preload, /showAccountMenu:.*rate-limit:show-account-menu/);
  assert.match(preload, /logoutAccount:.*rate-limit:logout-account/);
  assert.match(styles, /\.account-row\s*\{[^}]*-webkit-app-region:\s*no-drag;/s);
});
