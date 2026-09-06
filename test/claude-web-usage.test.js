const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { ClaudeWebUsage, parseWebUsage, responseKind, partitionForAccount, retryDelay } = require("../claude-web-usage");
const server = require("../server");

const org = "11111111-1111-4111-8111-111111111111";
const otherOrg = "22222222-2222-4222-8222-222222222222";
const account = { id: "claude-one", type: "claude", providerAccountId: "account-one", email: "one@example.test", organization: org };
const bootstrap = { account: { uuid: account.providerAccountId, email_address: account.email } };
const payload = { five_hour: { utilization: 1.5, resets_at: "2026-09-06T05:00:00Z" }, seven_day: { utilization: 0, resets_at: null } };
const bootstrapUrl = (organization = org) => `https://claude.ai/edge-api/bootstrap/${organization}/app_start?include_system_prompts=false`;
const usageUrl = (organization = org) => `https://claude.ai/api/organizations/${organization}/usage`;

function harness(options = {}) {
  const windows = [];
  const sessions = new Map();
  let clock = Date.parse("2026-09-06T01:00:00Z");
  class Window extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.destroyed = false;
      this.bodies = new Map();
      this.webContents = new EventEmitter();
      this.webContents.debugger = new EventEmitter();
      this.webContents.debugger.attach = () => {};
      this.webContents.debugger.sendCommand = async (method, params) => method === "Network.getResponseBody"
        ? this.bodies.get(params.requestId) : {};
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
      windows.push(this);
    }
    loadURL(url) {
      this.url = url;
      this.webContents.emit("did-start-navigation", {}, url, false, true);
      return Promise.resolve();
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    show() { this.shown = true; }
    focus() { this.focused = true; }
  }
  const session = {
    fromPartition(partition) {
      if (!sessions.has(partition)) {
        const item = new EventEmitter();
        item.setPermissionRequestHandler = (handler) => { item.permissionRequest = handler; };
        item.setPermissionCheckHandler = (handler) => { item.permissionCheck = handler; };
        item.clearStorageData = async () => { item.cleared = true; };
        sessions.set(partition, item);
      }
      return sessions.get(partition);
    }
  };
  const reader = new ClaudeWebUsage({ BrowserWindow: Window, session, now: () => clock, ...options });
  let id = 0;
  const send = (window, url, body, response = {}) => {
    const requestId = String(++id);
    const debuggerApi = window.webContents.debugger;
    window.bodies.set(requestId, { body: JSON.stringify(body), base64Encoded: false });
    debuggerApi.emit("message", {}, "Network.requestWillBeSent", { requestId, request: { url, method: "GET" } });
    debuggerApi.emit("message", {}, "Network.responseReceived", { requestId, response: { url, status: 200, ...response } });
    debuggerApi.emit("message", {}, "Network.loadingFinished", { requestId, encodedDataLength: 100 });
    return requestId;
  };
  const complete = (window, data = payload) => {
    send(window, usageUrl(), data);
    send(window, bootstrapUrl(), bootstrap);
  };
  return { reader, windows, sessions, send, complete, advance: (ms) => { clock += ms; } };
}

test("web usage preserves exact percentages, timestamps, and account identity", () => {
  const result = parseWebUsage(account, bootstrap, payload, org, new Date("2026-09-06T01:00:00Z"));
  assert.equal(result.source, "claude_web_usage");
  assert.equal(result.email, account.email);
  assert.equal(result.organization, org);
  assert.equal(result.windows[0].remainingPercent, 98.5);
  assert.equal(result.windows[0].resetAt, "2026-09-06T05:00:00.000Z");
  assert.equal(result.windows[1].resetAt, null);
  assert.equal(result.fetchedAt, "2026-09-06T01:00:00.000Z");
});

test("web parser rejects ambiguous identities, another user, and another organization", () => {
  for (const changed of [{ providerAccountId: "different" }, { email: "different@example.test" }, { organization: otherOrg }]) {
    assert.throws(() => parseWebUsage({ ...account, ...changed }, bootstrap, payload, org), /different account or organization/);
  }
  for (const missing of [{}, { account: { uuid: "one" } }, { account: { email_address: "one@example.test" } }]) {
    assert.throws(() => parseWebUsage(account, missing, payload, org), /verify/);
  }
});

test("web parser never converts missing, null, boolean, or out-of-range utilization into usage", () => {
  for (const utilization of [null, undefined, false, "0", NaN, Infinity, -1, 101]) {
    assert.throws(() => parseWebUsage(account, bootstrap, { ...payload, five_hour: { ...payload.five_hour, utilization } }, org), /invalid allowance/);
  }
  assert.throws(() => parseWebUsage(account, bootstrap, {}, org), /no allowance/);
  assert.deepEqual(parseWebUsage(account, bootstrap, { seven_day: payload.seven_day }, org).windows.map((window) => window.label), ["weekly"]);
  for (const resets_at of [undefined, "not a date"]) {
    assert.throws(() => parseWebUsage(account, bootstrap, { ...payload, five_hour: { ...payload.five_hour, resets_at } }, org), /invalid reset/);
  }
});

test("only exact Claude bootstrap and usage paths are observed", () => {
  assert.deepEqual(responseKind(bootstrapUrl()), { kind: "bootstrap", organization: org });
  assert.deepEqual(responseKind(usageUrl()), { kind: "usage", organization: org });
  for (const url of ["invalid", usageUrl().replace("https:", "http:"), usageUrl().replace("claude.ai", "claude.ai.example.test"), `${usageUrl()}/other`, "https://claude.ai/api/auth/login"]) {
    assert.equal(responseKind(url), null);
  }
  assert.notEqual(partitionForAccount("one"), partitionForAccount("two"));
  assert.match(partitionForAccount("../one@example.test"), /^persist:claude-web-[a-f0-9]{64}$/);
});

test("provider retry delay honors long Retry-After values without shortening them", () => {
  const now = Date.parse("2026-09-06T01:00:00Z");
  assert.equal(retryDelay("3600", now), 3600000);
  assert.equal(retryDelay("Sun, 06 Sep 2026 02:00:00 GMT", now), 3600000);
  for (const value of [undefined, "0", "-1", "invalid"]) assert.equal(retryDelay(value, now), 150000);
});

test("a poll waits for both matching responses and concurrent reads share one window", async () => {
  const h = harness();
  const first = h.reader.read(account);
  assert.equal(first, h.reader.read(account));
  assert.equal(h.windows.length, 1);
  h.complete(h.windows[0]);
  const result = await first;
  assert.equal(result.windows[0].usedPercent, 1.5);
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.sessions.values().next().value.listenerCount("will-download"), 0);
  h.advance(60000);
  const second = h.reader.read(account);
  h.complete(h.windows[1], { ...payload, five_hour: { ...payload.five_hour, utilization: 2 } });
  const updated = await second;
  assert.equal(updated.windows[0].usedPercent, 2);
  assert.equal(Date.parse(updated.fetchedAt) - Date.parse(result.fetchedAt), 60000);
  h.reader.close();
});

test("remote page has no preload or Node bridge, denies permissions, popups and downloads", async () => {
  const h = harness();
  const pending = h.reader.read(account);
  const window = h.windows[0];
  assert.equal(window.config.show, false);
  assert.equal(window.config.webPreferences.sandbox, true);
  assert.equal(window.config.webPreferences.contextIsolation, true);
  assert.equal(window.config.webPreferences.nodeIntegration, false);
  assert.equal(window.config.webPreferences.preload, undefined);
  assert.deepEqual(window.openHandler({ url: "https://example.test" }), { action: "deny" });
  const session = window.config.webPreferences.session;
  session.permissionRequest(null, "media", (allowed) => assert.equal(allowed, false));
  assert.equal(session.permissionCheck(), false);
  let prevented = false;
  session.emit("will-download", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  window.webContents.emit("will-navigate", { preventDefault() {} }, "file:///tmp/other");
  await assert.rejects(pending, /unsupported destination/);
});

test("429 backs off all reads and sign-in until the full provider delay passes", async () => {
  const h = harness();
  const pending = h.reader.read(account);
  h.send(h.windows[0], usageUrl(), {}, { status: 429, headers: { "Retry-After": "3600" } });
  await assert.rejects(pending, /rate limiting/);
  h.advance(59 * 60 * 1000);
  await assert.rejects(h.reader.read(account), /rate limiting/);
  await assert.rejects(h.reader.openLogin(account), /rate limiting/);
  assert.equal(h.windows.length, 1);
  h.advance(60000);
  const retry = h.reader.read(account);
  h.complete(h.windows[1]);
  await retry;
});

test("authentication errors, cached responses and mismatched organizations cannot produce fresh usage", async () => {
  for (const response of [{ status: 401 }, { status: 403 }, { status: 500 }, { fromDiskCache: true }, { fromServiceWorker: true }]) {
    const h = harness();
    const pending = h.reader.read(account);
    h.send(h.windows[0], usageUrl(), payload, response);
    await assert.rejects(pending);
    assert.equal(h.windows[0].destroyed, true);
  }
  const h = harness();
  const pending = h.reader.read(account);
  h.send(h.windows[0], bootstrapUrl(otherOrg), bootstrap);
  h.send(h.windows[0], usageUrl(), payload);
  await assert.rejects(pending, /organizations did not match/);
});

test("page-level 429 honors Retry-After even without a tracked API request", async () => {
  const h = harness();
  const pending = h.reader.read(account);
  h.windows[0].webContents.debugger.emit("message", {}, "Network.responseReceived", {
    requestId: "document", type: "Document", response: { url: "https://claude.ai/settings/usage", status: 429, headers: { "retry-after": "3600" } }
  });
  await assert.rejects(pending, /rate limiting/);
  h.advance(60000);
  await assert.rejects(h.reader.read(account), /3540s/);
  assert.equal(h.windows.length, 1);
});

test("429 followed by logout preserves a usable error for subsequent read and sign-in", async () => {
  const h = harness();
  const pending = h.reader.read(account);
  h.send(h.windows[0], usageUrl(), {}, { status: 429, headers: { "Retry-After": "3600" } });
  await assert.rejects(pending, /rate limiting/);
  await h.reader.logout(account);
  await assert.rejects(h.reader.read(account), /rate limiting/);
  await assert.rejects(h.reader.openLogin(account), /rate limiting/);
  assert.equal(h.windows.length, 1);
});

test("session clearing blocks concurrent reads and sign-in until storage is cleared", async () => {
  const h = harness();
  const pending = h.reader.read(account);
  const rejected = assert.rejects(pending, /session changed/);
  let clear;
  h.windows[0].config.webPreferences.session.clearStorageData = () => new Promise((resolve) => { clear = resolve; });
  const logout = h.reader.logout(account);
  await assert.rejects(h.reader.read(account), /being cleared/);
  await assert.rejects(h.reader.openLogin(account), /being cleared/);
  assert.equal(h.windows.length, 1);
  clear();
  await logout;
  await rejected;
  assert.equal(h.windows[0].destroyed, true);
});

test("an edited account cannot reuse a pending or just-completed login for another identity", async () => {
  const h = harness();
  const pending = h.reader.read(account);
  const rejected = assert.rejects(pending, /session changed/);
  const changed = h.reader.read({ ...account, organization: otherOrg });
  h.complete(h.windows[1]);
  await assert.rejects(changed, /different account or organization/);
  await rejected;
  await h.reader.openLogin(account);
  h.complete(h.windows[2]);
  await new Promise(setImmediate);
  await assert.rejects(h.reader.read({ ...account, email: "another@example.test" }), /different account or organization/);
});

test("logout cancels an in-flight read and clears only that account's browser session", async () => {
  const h = harness();
  const pending = h.reader.read(account);
  const rejected = assert.rejects(pending, /session changed/);
  await h.reader.logout(account);
  h.complete(h.windows[0]);
  await rejected;
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.sessions.get(partitionForAccount(account.id)).cleared, true);
  assert.equal(h.sessions.size, 1);
  h.reader.close();
  assert.throws(() => h.reader.read(account), /closed/);
});

test("new page navigation discards responses from the previous document", async () => {
  const h = harness();
  const pending = h.reader.read(account);
  const window = h.windows[0];
  h.send(window, bootstrapUrl(otherOrg), bootstrap);
  window.webContents.emit("did-start-navigation", {}, "https://claude.ai/new", false, true);
  h.complete(window);
  assert.equal((await pending).organization, org);
});

test("login remains interactive, completes once, and makes its verified reading available", async () => {
  let completions = 0;
  const h = harness({ onSignedIn: () => { completions += 1; } });
  await h.reader.openLogin(account);
  await h.reader.openLogin(account);
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].config.show, true);
  await assert.rejects(h.reader.read(account), /Sign in/);
  h.complete(h.windows[0]);
  await new Promise(setImmediate);
  assert.equal(completions, 1);
  const result = await h.reader.read(account);
  assert.equal(result.source, "claude_web_usage");
  assert.equal(h.windows.length, 1);
  const next = h.reader.read(account);
  h.complete(h.windows[1]);
  await next;
});

test("a hung page is bounded and its window is cleaned up", async () => {
  const h = harness({ timeoutMs: 10 });
  await assert.rejects(h.reader.read(account), /timed out/);
  assert.equal(h.windows[0].destroyed, true);
});

test("Electron provider failures preserve cached values and timestamp with an immediate stale state", async () => {
  const previous = parseWebUsage(account, bootstrap, payload, org);
  const identity = { ...account, lastUsage: previous };
  let reads = 0;
  server.setClaudeWebProvider({ read: async (requested) => {
    assert.equal(requested.id, account.id);
    reads += 1;
    throw new Error("Sign in to Claude in Usage Meter.");
  } });
  try {
    const result = await server._test.refreshIdentity({ identities: [identity] }, identity);
    assert.equal(reads, 1);
    assert.equal(result.stale, true);
    assert.equal(result.data.fetchedAt, previous.fetchedAt);
    assert.equal(result.data.windows[0].usedPercent, previous.windows[0].usedPercent);
    assert.match(result.error, /Sign in/);
  } finally { server.setClaudeWebProvider(null); }
});

test("Electron logout calls the web provider without launching Claude Code", async () => {
  let loggedOut = null;
  server.setClaudeWebProvider({ logout: async (requested) => { loggedOut = requested.id; } });
  try {
    await server._test.runLogoutForAccount(account, false, () => assert.fail("Claude CLI must not run"));
    assert.equal(loggedOut, account.id);
  } finally { server.setClaudeWebProvider(null); }
});

test("manual refresh and login completion coalesce into one follow-up after an active snapshot", async () => {
  const fs = require("node:fs/promises");
  const vm = require("node:vm");
  const source = await fs.readFile(require.resolve("../electron-main"), "utf8");
  const start = source.indexOf("async function refreshSnapshot(");
  const end = source.indexOf("function startBackgroundRefresh(", start);
  let complete;
  let reads = 0;
  const snapshot = { results: [] };
  const context = {
    refreshPromise: null, followupRefreshPromise: null, accountMutationGeneration: 0,
    latestSnapshot: null, nowMs: Date.now,
    refreshAllAccounts: async () => {
      reads += 1;
      if (reads === 1) await new Promise((resolve) => { complete = resolve; });
      return snapshot;
    },
    preserveRecentSuccessfulResults: (value) => value,
    broadcastSnapshot() {}, queueAutoStart() {}, logRefreshMetric() {}
  };
  vm.runInNewContext(`${source.slice(start, end)}; this.refreshSnapshot = refreshSnapshot;`, context);
  const first = context.refreshSnapshot();
  const requests = Array.from({ length: 5 }, () => context.refreshSnapshot({ forceClaudeUsage: true }));
  assert.equal(reads, 1);
  complete();
  await Promise.all([first, ...requests]);
  assert.equal(reads, 2);
});
