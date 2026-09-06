const crypto = require("crypto");

const usagePage = "https://claude.ai/settings/usage";
const pollIntervalMs = 60000;
const signInMessage = "Sign in to Claude in Usage Meter to read live usage.";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const bootstrapPath = new RegExp(`^/edge-api/bootstrap/(${uuid})/app_start$`, "i");
const usagePath = new RegExp(`^/api/organizations/(${uuid})/usage$`, "i");

function responseKind(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://claude.ai") return null;
    const bootstrap = url.pathname.match(bootstrapPath);
    const usage = url.pathname.match(usagePath);
    if (!bootstrap && !usage) return null;
    return { kind: bootstrap ? "bootstrap" : "usage", organization: (bootstrap || usage)[1] };
  } catch {
    return null;
  }
}

function partitionForAccount(accountId) {
  return `persist:claude-web-${crypto.createHash("sha256").update(accountId).digest("hex")}`;
}

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

// The page performs its own authenticated requests. Only its account and usage
// response bodies are observed; cookies, request headers and tokens stay in Chromium.
class ClaudeWebUsage {
  constructor({ BrowserWindow, session, onSignedIn = () => {}, now = Date.now, timeoutMs = 25000 }) {
    this.BrowserWindow = BrowserWindow;
    this.session = session;
    this.onSignedIn = onSignedIn;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.entries = new Map();
    this.closed = false;
  }

  entry(account) {
    if (this.closed) throw new Error("Claude web reader is closed.");
    if (!this.entries.has(account.id)) {
      this.entries.set(account.id, { generation: 0, retryAt: 0, operation: null, ready: null, clearing: null });
    }
    return this.entries.get(account.id);
  }

  read(account) {
    const entry = this.entry(account);
    if (entry.clearing) return Promise.reject(new Error("Claude web session is being cleared. Sign in to Claude after logout finishes."));
    if (entry.operation && entry.operation.binding !== accountBinding(account)) this.cancel(entry);
    if (entry.operation) {
      return entry.operation.login ? Promise.reject(new Error(signInMessage)) : entry.operation.promise;
    }
    if (this.now() < entry.retryAt) return Promise.reject(this.backoffError(entry));
    if (entry.ready) {
      const result = entry.ready;
      entry.ready = null;
      try { assertAccount(account, result); } catch (error) { return Promise.reject(error); }
      return Promise.resolve(result);
    }
    return this.capture(account, entry, false);
  }

  async openLogin(account) {
    const entry = this.entry(account);
    if (entry.clearing) throw new Error("Claude web session is being cleared. Sign in to Claude after logout finishes.");
    if (entry.operation && entry.operation.binding !== accountBinding(account)) this.cancel(entry);
    if (entry.operation?.login) {
      entry.operation.window.show();
      entry.operation.window.focus();
      return;
    }
    if (this.now() < entry.retryAt) throw this.backoffError(entry);
    this.cancel(entry);
    const generation = entry.generation;
    this.capture(account, entry, true).then(() => {
      if (entry.generation === generation) this.onSignedIn();
    }).catch(() => {});
  }

  capture(account, entry, login) {
    const expected = { ...account };
    const generation = entry.generation;
    const webSession = this.session.fromPartition(partitionForAccount(account.id));
    webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    webSession.setPermissionCheckHandler(() => false);
    const denyDownload = (event) => event.preventDefault();
    webSession.on("will-download", denyDownload);
    const window = new this.BrowserWindow({
      title: "Usage Meter — Claude sign-in",
      width: 1000,
      height: 780,
      show: login,
      webPreferences: { session: webSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    const contents = window.webContents;
    const requests = new Map();
    let bootstrap = null;
    let usage = null;
    let document = 0;
    let settled = false;
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      requests.clear();
      webSession.removeListener("will-download", denyDownload);
      if (entry.operation?.promise === promise) entry.operation = null;
      if (!window.isDestroyed()) window.destroy();
      if (generation !== entry.generation) {
        reject(new Error("Claude web session changed during refresh."));
        return;
      }
      if (result && login) entry.ready = result;
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(login ? signInMessage : "Claude web usage timed out. Sign in to Claude to check the browser session.")), login ? 10 * 60 * 1000 : this.timeoutMs);
    entry.operation = { promise, window, login, binding: accountBinding(account), cancel: () => finish(new Error("Claude web refresh was cancelled.")) };

    const allowedNavigation = (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && (url.hostname === "claude.ai"
          || (login && ["accounts.google.com", "appleid.apple.com", "account.apple.com"].includes(url.hostname)));
      } catch { return false; }
    };
    for (const eventName of ["will-navigate", "will-redirect"]) {
      contents.on(eventName, (event, url) => {
        if (!allowedNavigation(url)) {
          event.preventDefault();
          finish(new Error("Claude sign-in opened an unsupported destination. Sign in to Claude again."));
        }
      });
    }
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return;
      document += 1;
      bootstrap = usage = null;
      requests.clear();
    });
    contents.on("did-navigate", (_event, value) => {
      if (!login && new URL(value).pathname.startsWith("/login")) finish(new Error(signInMessage));
    });
    contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) finish(new Error("Claude web usage could not load. Check your connection or sign in to Claude again."));
    });
    contents.on("render-process-gone", () => finish(new Error("Claude web usage browser stopped.")));
    window.on("closed", () => finish(new Error(signInMessage)));

    const accept = () => {
      if (!bootstrap || !usage || settled || generation !== entry.generation) return;
      if (bootstrap.organization !== usage.organization) {
        finish(new Error("Claude web account and usage organizations did not match. Sign in to Claude again."));
        return;
      }
      try {
        finish(null, parseWebUsage(expected, bootstrap.body, usage.body, usage.organization, new Date(this.now())));
      } catch (error) { finish(error); }
    };
    contents.debugger.on("message", async (_event, method, params) => {
      if (settled || generation !== entry.generation) return;
      if (method === "Network.responseReceived" && params.type === "Document") {
        let origin;
        try { origin = new URL(params.response.url).origin; } catch { return; }
        if (origin === "https://claude.ai") {
          if (params.response.status === 429) {
            this.rateLimited(entry, params.response);
            finish(this.backoffError(entry));
          } else if (!login && [401, 403].includes(params.response.status)) {
            finish(new Error(signInMessage));
          }
        }
      }
      if (method === "Network.requestWillBeSent") {
        const kind = responseKind(params.request.url);
        if (kind && params.request.method === "GET") requests.set(params.requestId, { ...kind, document });
      }
      const request = requests.get(params.requestId);
      if (!request) return;
      if (method === "Network.responseReceived") {
        const response = params.response;
        if (response.status === 429) {
          this.rateLimited(entry, response);
          finish(this.backoffError(entry));
        } else if (response.status === 401 || response.status === 403) {
          finish(new Error(signInMessage));
        } else if (response.status !== 200 || response.fromDiskCache || response.fromServiceWorker) {
          finish(new Error("Claude web usage did not return a fresh response."));
        } else request.received = true;
      }
      if (method === "Network.requestServedFromCache") finish(new Error("Claude web usage returned a cached response."));
      if (method === "Network.loadingFailed") finish(new Error("Claude web usage request failed."));
      if (method !== "Network.loadingFinished") return;
      requests.delete(params.requestId);
      if (!request.received || request.document !== document) return;
      try {
        if (params.encodedDataLength > 2 * 1024 * 1024) throw new Error("Response is too large.");
        const response = await contents.debugger.sendCommand("Network.getResponseBody", { requestId: params.requestId });
        if (settled || generation !== entry.generation || request.document !== document) return;
        if (response.body.length > 3 * 1024 * 1024) throw new Error("Response is too large.");
        const body = JSON.parse(response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body);
        if (request.kind === "bootstrap") bootstrap = { body, organization: request.organization };
        else usage = { body, organization: request.organization };
        accept();
      } catch {
        finish(new Error("Claude web usage response could not be read."));
      }
    });
    contents.debugger.on("detach", () => finish(new Error("Claude web usage observer disconnected.")));
    try {
      contents.debugger.attach("1.3");
      // An initial about:blank target may not answer Network.enable until navigation starts.
      contents.debugger.sendCommand("Network.enable").catch(() => finish(new Error("Claude web usage observer could not start.")));
      window.loadURL(usagePage).catch(() => finish(new Error("Claude web usage could not load. Sign in to Claude again.")));
    } catch { finish(new Error("Claude web usage browser could not start.")); }
    return promise;
  }

  cancel(entry) {
    entry.generation += 1;
    entry.operation?.cancel();
    entry.ready = null;
  }

  rateLimited(entry, response) {
    const retryAfter = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
    entry.retryAt = this.now() + retryDelay(retryAfter, this.now());
  }

  backoffError(entry) {
    return new Error(`Claude is rate limiting web usage. Retrying in ${Math.max(1, Math.ceil((entry.retryAt - this.now()) / 1000))}s.`);
  }

  async logout(account) {
    const entry = this.entry(account);
    if (entry.clearing) return entry.clearing;
    this.cancel(entry);
    entry.clearing = this.session.fromPartition(partitionForAccount(account.id)).clearStorageData();
    try { await entry.clearing; } finally { entry.clearing = null; }
  }

  remove(account) { return this.logout(account, true); }

  close() {
    for (const entry of this.entries.values()) this.cancel(entry);
    this.closed = true;
  }
}

module.exports = { ClaudeWebUsage, parseWebUsage, responseKind, partitionForAccount, retryDelay, pollIntervalMs };
