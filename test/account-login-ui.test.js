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

test("cached Claude usage exposes a sign-in action when login is required", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const start = source.indexOf("function renderConnected(");
  const end = source.indexOf("function renderResult(");
  assert.ok(start >= 0 && end > start, "connected account renderer must be present");

  const elements = {
    summary: { textContent: "", title: "", className: "" },
    row: { classList: classList() },
    connectButton: {
      classList: classList(),
      dataset: {},
      textContent: "",
      title: ""
    }
  };
  let accountType = "claude";
  const context = {
    accountElements: new Map([["claude-1", elements]]),
    rowsExpanded: true,
    getAccount: () => ({ type: accountType }),
    buildSummary: () => "5h 100%",
    renderLimitWindows: () => {},
    buildResetTitle: () => "reset detail",
    isLoginNeededError: (error) => /not logged in/i.test(error || ""),
    showStatusSummary(target, text, className, title = "") {
      target.summary.textContent = text;
      target.summary.className = `account-summary ${className}`;
      target.summary.title = title;
    },
    updateAccountState: () => {}
  };

  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.renderConnected = renderConnected;`,
    context
  );

  context.renderConnected("claude-1", { windows: [] }, {
    stale: true,
    error: "Claude is not logged in on this machine."
  });

  assert.equal(elements.summary.textContent, "Last known");
  assert.equal(elements.connectButton.textContent, "Sign in");
  assert.equal(elements.connectButton.dataset.action, "login");
  assert.equal(elements.connectButton.classList.values.has("hidden"), false);

  accountType = "codex";
  context.renderConnected("claude-1", { windows: [] }, {
    stale: true,
    error: "Account is not logged in."
  });

  assert.equal(elements.summary.textContent, "Last known · Refresh unavailable");
  assert.equal(elements.connectButton.classList.values.has("hidden"), true);

  context.renderDisconnected("claude-1");
  assert.equal(elements.connectButton.textContent, "Connect");
  assert.equal(elements.connectButton.title, "Connect account");

  accountType = "claude";
  context.renderConnected("claude-1", { windows: [] }, {
    stale: true,
    error: "Claude is not logged in on this machine."
  });
  context.renderError("claude-1", "Refresh timed out.");
  assert.equal(elements.connectButton.textContent, "Retry");
  assert.equal(elements.connectButton.title, "Try refreshing usage again");
  assert.equal(elements.connectButton.dataset.action, "retry");
});

test("account login click preserves provider-specific action copy", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const start = source.indexOf("function createAccountRow(");
  const end = source.indexOf("function renderCurrentRows(");
  assert.ok(start >= 0 && end > start, "account row factory must be present");

  async function clickLogin(type) {
    let clickHandler = null;
    let openedAccountId = null;
    const connectButton = {
      classList: classList(),
      dataset: { action: "login" },
      disabled: false,
      textContent: type === "claude" ? "Sign in" : "Connect",
      addEventListener(event, handler) {
        if (event === "click") clickHandler = handler;
      }
    };
    const elements = {
      name: { textContent: "" },
      typeTag: { textContent: "" },
      limitGrid: { classList: classList() },
      summary: { textContent: "", className: "", title: "" },
      connectButton
    };
    const node = {
      classList: classList(),
      querySelector(selector) {
        return {
          ".account-name": elements.name,
          ".account-type": elements.typeTag,
          ".limit-grid": elements.limitGrid,
          ".account-summary": elements.summary,
          ".connect-button": elements.connectButton
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
      },
      updateAccountState: () => {},
      renderConnected: () => {},
      renderDisconnected: () => {}
    };

    vm.runInNewContext(
      `${source.slice(start, end)}\nthis.createAccountRow = createAccountRow;`,
      context
    );

    context.createAccountRow({ id: `${type}-1`, type, label: "Account" });
    assert.equal(typeof clickHandler, "function");
    await clickHandler();

    return { connectButton, openedAccountId };
  }

  const claude = await clickLogin("claude");
  assert.equal(claude.openedAccountId, "claude-1");
  assert.equal(claude.connectButton.textContent, "Sign in");

  const codex = await clickLogin("codex");
  assert.equal(codex.openedAccountId, "codex-1");
  assert.equal(codex.connectButton.textContent, "Connect");
});
