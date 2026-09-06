const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ClaudeWebUsage, parseWebUsage, retryDelay, pageRead, chromeCommand } = require("../claude-web-usage");
const server = require("../server");
const org = "11111111-1111-4111-8111-111111111111";
const otherOrg = "22222222-2222-4222-8222-222222222222";
const account = { id: "claude-one", type: "claude", providerAccountId: "account-one", email: "one@example.test", organization: org };
const bootstrap = { account: { uuid: account.providerAccountId, email_address: account.email } };
const payload = { five_hour: { utilization: 1.5, resets_at: "2026-09-06T05:00:00Z" }, seven_day: { utilization: 0, resets_at: null } };
function harness(options = {}) {
  let clock = Date.parse("2026-09-06T01:00:00Z");
  const calls = [];
  let handle = async (command) => {
    if (command.action === "open") return { tabId: "123" };
    const requestId = command.script.match(/\)\("([^"]+)"/)[1];
    return { requestId, identity: account, usage: payload };
  };
  const reader = new ClaudeWebUsage({ now: () => clock, wait: async (ms) => { clock += ms; }, run: async (command) => { calls.push(command); return handle(command); }, ...options });
  reader.tabs[account.id] = "123";
  return { reader, calls, set: (handler) => { handle = handler; }, advance: (ms) => { clock += ms; } };
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


test("backoff honors full Retry-After and does not turn zero into an immediate retry", () => {
  const now = Date.parse("2026-09-06T01:00:00Z");
  assert.equal(retryDelay("3600", now), 3600000);
  assert.equal(retryDelay("Sun, 06 Sep 2026 02:00:00 GMT", now), 3600000);
  for (const value of [undefined, "0", "-1", "invalid"]) assert.equal(retryDelay(value, now), 150000);
});

test("reads share one operation and exact timestamps advance on the next poll", async () => {
  const h = harness();
  const first = h.reader.read(account);
  assert.equal(first, h.reader.read(account));
  const data = await first;
  assert.equal(h.calls.length, 1);
  h.advance(60000);
  assert.equal(Date.parse((await h.reader.read(account)).fetchedAt) - Date.parse(data.fetchedAt), 60000);
  assert.ok(h.calls.every((call) => call.action === "read"));
});

test("Sign In opens Chrome and persists only its tab association", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-usage-test-"));
  const statePath = path.join(directory, "tabs.json");
  try {
    let callbacks = 0;
    const h = harness({ statePath, onSignedIn: () => { callbacks += 1; } });
    await h.reader.openLogin(account);
    assert.equal(callbacks, 1);
    assert.deepEqual(h.calls[0], { action: "open", tabId: "123", url: "https://claude.ai/settings/usage" });
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath)), { [account.id]: "123" });
    const restarted = new ClaudeWebUsage({ statePath });
    assert.equal(restarted.tabs[account.id], "123");
    await restarted.logout(account);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath)), {});
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("missing association never launches Chrome in the background", async () => {
  const h = harness();
  delete h.reader.tabs[account.id];
  await assert.rejects(h.reader.read(account), /Sign in/);
  assert.equal(h.calls.length, 0);
});

test("429 blocks automatic reads and Sign In and survives disconnect", async () => {
  const h = harness();
  h.set(async () => ({ status: 429, retryAfter: "3600", error: "Throttled" }));
  await assert.rejects(h.reader.read(account), /rate limiting/);
  await h.reader.logout(account);
  h.advance(60000);
  await assert.rejects(h.reader.read(account), /3540s/);
  await assert.rejects(h.reader.openLogin(account), /3540s/);
  assert.equal(h.calls.length, 1);
});

test("disconnect discards in-flight reads and never clears Chrome credentials", async () => {
  const h = harness();
  let finish;
  h.set(() => new Promise((resolve) => { finish = resolve; }));
  const pending = h.reader.read(account);
  await h.reader.logout(account);
  finish({ error: "old response" });
  await assert.rejects(pending, /connection changed/);
  await assert.rejects(h.reader.read(account), /Sign in/);
  assert.equal(h.calls.length, 1);
});

test("disconnect during Sign In cannot restore the tab association", async () => {
  const h = harness();
  let finish;
  h.set(() => new Promise((resolve) => { finish = resolve; }));
  const pending = h.reader.openLogin(account);
  await h.reader.logout(account);
  finish({ tabId: "stale" });
  await pending;
  assert.equal(h.reader.tabs[account.id], undefined);
});

test("hung reads time out and wrong request IDs are rejected", async () => {
  const h = harness({ timeoutMs: 500 });
  h.set(async () => ({ pending: true }));
  await assert.rejects(h.reader.read(account), /timed out/);
  h.set(async () => ({ requestId: "old", identity: account, usage: payload }));
  await assert.rejects(h.reader.read(account), /did not match/);
});

function pageHarness({ status = 200, identity = bootstrap, switchIdentity = false } = {}) {
  const calls = [];
  const context = {
    window: {}, location: { origin: "https://claude.ai", pathname: "/new" },
    performance: { getEntriesByType: () => [{ name: `https://claude.ai/edge-api/bootstrap/${org}/app_start` }] },
    AbortSignal, Date,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const body = String(url).includes("/app_start") ? (switchIdentity && calls.length === 3 ? { account: { uuid: "switched", email_address: account.email } } : identity) : payload;
      return { status, headers: { get: () => "3600" }, text: async () => JSON.stringify(body) };
    }
  };
  vm.createContext(context);
  return { calls, context, read: (id = "request") => JSON.parse(vm.runInContext(`(${pageRead.toString()})(${JSON.stringify(id)}, ${JSON.stringify(account)})`, context)) };
}

test("page collector reads only same-origin usage and rejects an account switch", async () => {
  const h = pageHarness();
  assert.equal(h.read().pending, true);
  await new Promise(setImmediate);
  const data = h.read();
  assert.equal(data.identity.email, account.email);
  assert.equal(data.usage.five_hour.utilization, 1.5);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every((call) => call.options.credentials === "same-origin" && call.options.cache === "no-store" && call.options.redirect === "error"));
  const changed = pageHarness({ switchIdentity: true });
  changed.read();
  await new Promise(setImmediate);
  assert.match(changed.read().error, /could not be read/);
});

test("wrong profile is rejected before fetching any usage", async () => {
  const h = pageHarness({ identity: { account: { uuid: "other", email_address: account.email } } });
  h.read();
  await new Promise(setImmediate);
  assert.match(h.read().error, /different Claude account/);
  assert.equal(h.calls.length, 1);
});

test("page auth failures and rate limits retain status and never return windows", async () => {
  for (const status of [401, 403, 429, 500]) {
    const h = pageHarness({ status });
    h.read();
    await new Promise(setImmediate);
    assert.equal(h.read().status, status);
    assert.equal(h.read().usage, undefined);
    assert.equal(h.calls.length, 1);
  }
});

test("native bridge rejects closed or off-origin tabs without executing JavaScript", () => {
  const context = { Application: () => ({ running: () => true, windows: () => [{ tabs: () => [{ id: () => "123", url: () => "https://claude.ai.example.test/" }] }] }) };
  assert.throws(() => vm.runInNewContext(`(${chromeCommand.toString()})({action:'read',tabId:'123',script:'should not run'})`, context), /navigated away/);
  assert.throws(() => vm.runInNewContext(`(${chromeCommand.toString()})({action:'read',tabId:'999'})`, context), /closed/);
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


test("wrong profile clears the tab association so Sign In uses the front Chrome profile", async () => {
  const h = harness();
  h.set(async (command) => command.action === "open" ? { tabId: "correct-profile" } : { mismatch: true, error: "different Claude account" });
  await assert.rejects(h.reader.read(account), /different Claude account/);
  await h.reader.openLogin(account);
  assert.equal(h.calls[1].tabId, undefined);
  assert.equal(h.reader.tabs[account.id], "correct-profile");
});

test("page collector coalesces requests and retains upstream backoff across new IDs", async () => {
  const h = pageHarness({ status: 429 });
  h.read("one");
  assert.equal(h.read("two").pending, true);
  await new Promise(setImmediate);
  assert.equal(h.read("two").status, 429);
  assert.equal(h.calls.length, 1);
});


test("Chrome permission failure disconnects the inaccessible profile for Sign In recovery", async () => {
  const h = harness();
  h.set(async (command) => {
    if (command.action === "open") return { tabId: "work-profile" };
    const failure = new Error("Sign in to Claude again after enabling Chrome JavaScript access.");
    failure.reconnect = true;
    throw failure;
  });
  await assert.rejects(h.reader.read(account), /Sign in to Claude/);
  await h.reader.openLogin(account);
  assert.equal(h.calls[1].tabId, undefined);
  assert.equal(h.reader.tabs[account.id], "work-profile");
});


test("saved organization keeps later polls working after Claude clears resource timings", async () => {
  const h = pageHarness();
  h.read("first");
  await new Promise(setImmediate);
  assert.equal(h.read("first").usage.five_hour.utilization, 1.5);
  h.context.performance.getEntriesByType = () => [];
  assert.equal(h.read("next").pending, true);
  await new Promise(setImmediate);
  assert.equal(h.read("next").usage.five_hour.utilization, 1.5);
  assert.equal(h.calls.length, 6);
});

test("Sign In reloads an existing Claude tab to restore its page context", () => {
  const tab = { id: () => "123", url: () => "https://claude.ai/new#settings/usage" };
  const window = { tabs: () => [tab] };
  const chrome = { running: () => true, launch() {}, activate() {}, windows: () => [window] };
  const result = JSON.parse(vm.runInNewContext(`(${chromeCommand.toString()})({action:'open',tabId:'123',url:'https://claude.ai/settings/usage'})`, { Application: () => chrome }));
  assert.equal(result.tabId, "123");
  assert.equal(tab.url, "https://claude.ai/settings/usage");
  assert.equal(window.activeTabIndex, 1);
});


test("saved account polls when resource timings were cleared before the first read", async () => {
  const h = pageHarness();
  h.context.performance.getEntriesByType = () => [];
  h.read();
  await new Promise(setImmediate);
  assert.equal(h.read().identity.organization, org);
  assert.equal(h.read().usage.five_hour.utilization, 1.5);
  assert.equal(h.calls.length, 3);
});


test("saved organization auth failure reconnects through the front Chrome profile", async () => {
  for (const status of [401, 403]) {
    const page = pageHarness({ status });
    page.read();
    await new Promise(setImmediate);
    const result = page.read();
    assert.equal(result.reconnect, true);
    const h = harness();
    h.set(async (command) => command.action === "open" ? { tabId: "matching-profile" } : result);
    await assert.rejects(h.reader.read(account), /Sign in to Claude/);
    await h.reader.openLogin(account);
    assert.equal(h.calls[1].tabId, undefined);
    assert.equal(h.reader.tabs[account.id], "matching-profile");
  }
});
