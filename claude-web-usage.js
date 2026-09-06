const crypto = require("node:crypto");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { atomicWriteJsonSync } = require("./atomic-file");

const usagePage = "https://claude.ai/settings/usage";
const pollIntervalMs = 60000;
const signInMessage = "Sign in to Claude in Chrome from Usage Meter and keep its usage tab open.";
const runFile = promisify(execFile);

function retryDelay(value, now) {
  const text = String(value || "").trim();
  const seconds = Number(text);
  if (text && Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(text);
  return Number.isFinite(date) && date > now ? date - now : 150000;
}

function accountBinding(account) {
  return JSON.stringify([account.providerAccountId, account.email, account.organization].map((value) => String(value || "").trim().toLowerCase()));
}

function assertAccount(expected, actual) {
  for (const key of ["providerAccountId", "email", "organization"]) {
    if (expected[key] && expected[key].trim().toLowerCase() !== actual[key].toLowerCase()) {
      throw new Error("This Claude web session belongs to a different account or organization. Sign in to Claude with the account saved in this row.");
    }
  }
}

function parseWebUsage(expected, bootstrap, usage, organization, now = new Date()) {
  const account = bootstrap?.account;
  const providerAccountId = typeof account?.uuid === "string" ? account.uuid.trim() : "";
  const email = typeof account?.email_address === "string" ? account.email_address.trim() : "";
  if (!providerAccountId || !email || !organization) {
    throw new Error("Claude web usage could not verify the signed-in account. Sign in to Claude again.");
  }
  const actual = { providerAccountId, email, organization };
  assertAccount(expected, actual);
  const windows = [["5-hour", usage?.five_hour], ["weekly", usage?.seven_day]].map(([label, raw]) => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw.utilization !== "number" || !Number.isFinite(raw.utilization)
      || raw.utilization < 0 || raw.utilization > 100) {
      throw new Error("Claude web usage returned an invalid allowance window.");
    }
    const reset = raw.resets_at === null ? null : typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) : NaN;
    if (reset !== null && !Number.isFinite(reset)) {
      throw new Error("Claude web usage returned an invalid reset time.");
    }
    return {
      label,
      usedPercent: raw.utilization,
      remainingPercent: 100 - raw.utilization,
      resetAt: reset === null ? null : new Date(reset).toISOString(),
      source: "claude_web_usage"
    };
  }).filter(Boolean);
  if (!windows.length) throw new Error("Claude web usage returned no allowance windows.");
  return { service: "claude", source: "claude_web_usage", ...actual, windows, fetchedAt: now.toISOString() };
}

// Runs in Chrome's ordinary page context. Authentication stays in Chrome;
// only the account identifiers, allowance windows and request status leave it.
function pageRead(requestId, expected) {
  if (location.origin !== "https://claude.ai" || location.pathname.startsWith("/login")) {
    return JSON.stringify({ error: "Sign in to Claude in Chrome." });
  }
  const key = "__usageMeterClaudeRead";
  if (window[key]?.requestId === requestId) return JSON.stringify(window[key]);
  if (window[key]?.pending) return JSON.stringify({ pending: true });
  if (window[key]?.retryAt > Date.now()) return JSON.stringify({ status: 429, retryAfter: String((window[key].retryAt - Date.now()) / 1000) });
  const names = performance.getEntriesByType("resource").map((entry) => entry.name);
  const pattern = /^https:\/\/claude\.ai\/edge-api\/bootstrap\/([0-9a-f-]{36})\/app_start(?:\?|$)/i;
  // Saved rows already bind an organization. Use that identifier even when
  // Claude clears resource timings; new rows can discover it from the page.
  const organizationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const observedUrl = names.reverse().find((name) => pattern.test(name));
  const organization = organizationPattern.test(expected.organization || "") ? expected.organization : observedUrl?.match(pattern)[1];
  if (!organization) return JSON.stringify({ pending: true, phase: "page loading" });
  const bootstrapUrl = `https://claude.ai/edge-api/bootstrap/${organization}/app_start`;
  window[key] = { requestId, pending: true, phase: "account response" };
  (async () => {
    const signal = AbortSignal.timeout(20000);
    const get = async (url) => {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "error", signal });
      if (response.status !== 200) {
        throw { status: response.status, retryAfter: response.headers.get("retry-after") };
      }
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw new Error("Response too large");
      return JSON.parse(text);
    };
    try {
      const body = await get(bootstrapUrl);
      const identity = { providerAccountId: body?.account?.uuid, email: body?.account?.email_address, organization };
      if (!identity.providerAccountId || !identity.email) throw new Error("Missing account");
      for (const field of ["providerAccountId", "email", "organization"]) {
        if (expected[field] && String(expected[field]).trim().toLowerCase() !== String(identity[field]).trim().toLowerCase()) {
          window[key] = { requestId, mismatch: true, error: "This Chrome profile is signed in to a different Claude account or organization. Bring the matching Chrome profile forward, then Sign in to Claude again." };
          return;
        }
      }
      window[key].phase = "usage response";
      const usage = await get(`/api/organizations/${organization}/usage`);
      // Recheck identity after usage so a simultaneous account switch cannot
      // pair the previous user with the new user's allowance in a shared org.
      window[key].phase = "account confirmation";
      const confirmed = await get(bootstrapUrl);
      if (confirmed?.account?.uuid !== identity.providerAccountId || confirmed?.account?.email_address !== identity.email) {
        throw new Error("Account changed");
      }
      window[key] = { requestId, identity, usage: { five_hour: usage.five_hour, seven_day: usage.seven_day } };
    } catch (error) {
      const text = String(error.retryAfter || "").trim();
      const seconds = Number(text);
      const date = Date.parse(text);
      const delay = text && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Number.isFinite(date) && date > Date.now() ? date - Date.now() : 150000;
      window[key] = { requestId, status: error.status, reconnect: error.status === 401 || error.status === 403, retryAfter: error.retryAfter, retryAt: error.status === 429 ? Date.now() + delay : 0,
        error: error.status === 401 || error.status === 403 ? "Sign in to Claude in Chrome." : "Claude usage could not be read from Chrome." };
    }
  })();
  return JSON.stringify({ requestId, pending: true });
}

// JXA uses Chrome's supported Apple Events interface. Only the selected tab is
// executed; polling neither opens Chrome nor switches the user's active tab.
function chromeCommand(command) {
  const chrome = Application("Google Chrome");
  if (!chrome.running() && command.action !== "open") throw new Error("Sign in to Claude in Chrome and keep Chrome open.");
  if (command.action === "open") chrome.launch();
  const windows = chrome.windows();
  let target = null;
  let targetWindow = null;
  let targetIndex = 0;
  for (const window of windows) {
    const tabs = window.tabs();
    for (let index = 0; index < tabs.length; index += 1) {
      if (String(tabs[index].id()) === String(command.tabId)) {
        target = tabs[index]; targetWindow = window; targetIndex = index + 1;
      }
    }
  }
  if (command.action === "open") {
    if (target && /^https:\/\/claude\.ai(?:\/|$)/.test(target.url())) {
      target.url = command.url;
    } else {
      if (!windows.length) {
        targetWindow = chrome.Window().make();
        target = targetWindow.activeTab();
        target.url = command.url;
        targetIndex = 1;
      } else {
        targetWindow = windows[0];
        target = chrome.Tab({ url: command.url });
        targetWindow.tabs.push(target);
        targetIndex = targetWindow.tabs.length;
      }
    }
    chrome.activate();
    targetWindow.index = 1;
    targetWindow.activeTabIndex = targetIndex;
    return JSON.stringify({ tabId: String(target.id()) });
  }
  if (!target) throw new Error("Sign in to Claude in Chrome again; its usage tab was closed.");
  if (!/^https:\/\/claude\.ai(?:\/|$)/.test(target.url())) throw new Error("Sign in to Claude in Chrome again; its usage tab has navigated away.");
  return target.execute({ javascript: command.script });
}

async function runChrome(command) {
  try {
    const { stdout } = await runFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", `(${chromeCommand.toString()})(${JSON.stringify(command)})`], { timeout: 10000, maxBuffer: 65536 });
    return JSON.parse(stdout.trim());
  } catch (error) {
    const message = String(error.stderr || error.message);
    if (/Apple Events|AppleEvents|javascript.*disabled|JavaScript.*turned off/i.test(message)) {
      const failure = new Error("Sign in to Claude again after allowing Usage Meter in macOS Privacy & Security > Automation and enabling Chrome View > Developer > Allow JavaScript from Apple Events.");
      failure.reconnect = true;
      throw failure;
    }
    if (/Sign in to Claude[^\n]*/.test(message)) throw new Error(message.match(/Sign in to Claude[^\n]*/)[0].replace(/ \(-?\d+\)$/, ""));
    throw new Error("Could not read Claude in Google Chrome. Sign in to Claude again to check Chrome's automation permission.");
  }
}

class ClaudeWebUsage {
  constructor({ statePath, onSignedIn = () => {}, run = runChrome, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 25000 } = {}) {
    this.statePath = statePath;
    this.onSignedIn = onSignedIn;
    this.run = run;
    this.now = now;
    this.wait = wait;
    this.timeoutMs = timeoutMs;
    this.entries = new Map();
    this.tabs = {};
    this.closed = false;
    if (statePath) {
      try { this.tabs = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* first run or invalid state requires Sign in */ }
      if (!this.tabs || typeof this.tabs !== "object" || Array.isArray(this.tabs)) this.tabs = {};
    }
  }

  save() { if (this.statePath) atomicWriteJsonSync(this.statePath, this.tabs); }

  entry(account) {
    if (this.closed) throw new Error("Claude web reader is closed.");
    if (!this.entries.has(account.id)) this.entries.set(account.id, { generation: 0, retryAt: 0, operation: null, login: null });
    return this.entries.get(account.id);
  }

  backoff(entry) {
    if (this.now() < entry.retryAt) throw new Error(`Claude is rate limiting web usage. Retrying in ${Math.max(1, Math.ceil((entry.retryAt - this.now()) / 1000))}s.`);
  }

  async openLogin(account) {
    const entry = this.entry(account);
    this.backoff(entry);
    if (entry.login) return entry.login;
    entry.generation += 1;
    const generation = entry.generation;
    entry.login = (async () => {
      const result = await this.run({ action: "open", tabId: this.tabs[account.id], url: usagePage });
      if (generation !== entry.generation) return;
      this.tabs[account.id] = result.tabId;
      this.save();
    })();
    try {
      await entry.login;
      entry.login = null;
      if (generation === entry.generation) this.onSignedIn();
    } finally { entry.login = null; }
  }

  read(account) {
    const entry = this.entry(account);
    try { this.backoff(entry); } catch (error) { return Promise.reject(error); }
    if (entry.login) return Promise.reject(new Error(signInMessage));
    if (!this.tabs[account.id]) return Promise.reject(new Error(signInMessage));
    if (entry.operation?.binding === accountBinding(account)) return entry.operation.promise;
    if (entry.operation) entry.generation += 1;
    const generation = entry.generation;
    const operation = { binding: accountBinding(account) };
    operation.promise = this.capture({ ...account }, entry, generation).finally(() => {
      if (entry.operation === operation) entry.operation = null;
    });
    entry.operation = operation;
    return operation.promise;
  }

  async capture(account, entry, generation) {
    const requestId = crypto.randomUUID();
    const tabId = this.tabs[account.id];
    const script = `(${pageRead.toString()})(${JSON.stringify(requestId)}, ${JSON.stringify({ providerAccountId: account.providerAccountId, email: account.email, organization: account.organization })})`;
    const deadline = this.now() + this.timeoutMs;
    let phase = "page loading";
    while (this.now() < deadline) {
      if (generation !== entry.generation) throw new Error("Claude Chrome connection changed during refresh.");
      let result;
      try {
        result = await this.run({ action: "read", tabId, script });
      } catch (error) {
        if (error.reconnect && generation === entry.generation) {
          delete this.tabs[account.id];
          this.save();
        }
        throw error;
      }
      if (generation !== entry.generation) throw new Error("Claude Chrome connection changed during refresh.");
      if (result.status === 429) {
        entry.retryAt = this.now() + retryDelay(result.retryAfter, this.now());
        this.backoff(entry);
      }
      if (result.mismatch || result.reconnect) {
        delete this.tabs[account.id];
        this.save();
      }
      if (result.error) throw new Error(result.error);
      if (!result.pending) {
        if (result.requestId !== requestId) throw new Error("Claude Chrome usage response did not match this refresh.");
        return parseWebUsage(account, { account: { uuid: result.identity?.providerAccountId, email_address: result.identity?.email } }, result.usage, result.identity?.organization, new Date(this.now()));
      }
      phase = result.phase || phase;
      await this.wait(250);
    }
    throw new Error(`Claude Chrome usage timed out waiting for ${phase}. Sign in to Claude again to check its usage tab.`);
  }

  async logout(account) {
    const entry = this.entry(account);
    entry.generation += 1;
    delete this.tabs[account.id];
    this.save();
    // Disconnect only this row. Chrome's shared login belongs to the user.
  }

  remove(account) { return this.logout(account); }

  close() {
    for (const entry of this.entries.values()) entry.generation += 1;
    this.closed = true;
  }
}

module.exports = { ClaudeWebUsage, parseWebUsage, retryDelay, pollIntervalMs, pageRead, chromeCommand };
