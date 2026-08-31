const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { existsSync } = require("fs");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const { atomicWriteFile, atomicWriteJson } = require("./atomic-file");

const app = express();
const port = Number(process.env.PORT || 4545);
const appDataDir = path.join(os.homedir(), ".rate-limit-tool");
const configPath = path.join(appDataDir, "accounts.json");
const configBackupPath = `${configPath}.bak`;
const automationStatePath = path.join(appDataDir, "automation-state.json");
const automationWorkspaceRoot = path.join(appDataDir, "automation-workspaces");
const claudeWorkspaceRoot = path.join(appDataDir, "claude-workspaces");
const codexIdentityRoot = path.join(appDataDir, "codex-identities");
const defaultCodexHome = path.join(os.homedir(), ".codex");
const legacySecondCodexHome = path.join(appDataDir, "codex-account-2");
const defaultWorkspace = process.cwd();
const timerKickPrompt = "Reply with exactly OK.";
const browserServerHost = "127.0.0.1";
const browserServerToken = crypto.randomBytes(32).toString("base64url");
let configWriteQueue = Promise.resolve();
const removedIdentities = new Map();
let activeClaudeLogin = null;

function resolveExecutable(name, fallbacks = []) {
  const pathCandidates = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, name));

  for (const candidate of [...fallbacks, ...pathCandidates]) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return name;
}

const codexBin = resolveExecutable("codex", [
  "/opt/homebrew/bin/codex",
  path.join(os.homedir(), ".local", "bin", "codex")
]);
const claudeBin = resolveExecutable("claude", [
  path.join(os.homedir(), ".local", "bin", "claude"),
  path.join(
    os.homedir(),
    "Library/Application Support/Claude/claude-code-vm/2.1.111/claude"
  )
]);
const googleChromeBin = process.env.RATE_LIMIT_TOOL_LOGIN_BROWSER
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const codexDeviceAuthUrl = "https://auth.openai.com/codex/device";
const scriptBin = resolveExecutable("script", ["/usr/bin/script"]);
const codexUsageEndpoint = "https://chatgpt.com/backend-api/wham/usage";
const codexOAuthTokenEndpoint = "https://auth.openai.com/oauth/token";
const codexOAuthClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const codexUsageRequestTimeoutMs = 10000;
const codexAuthRefreshTimeoutMs = 10000;
const codexTokenRefreshSkewMs = 60000;
const claudeFiveHourResetMaxMs = (5 * 60 * 60 * 1000) + (60 * 1000);

app.use(express.json());

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function createBrowserIndexHtml(html, token) {
  const tokenMeta = `<meta name="rate-limit-server-token" content="${escapeHtmlAttribute(token)}" />`;
  return html.replace("</head>", `${tokenMeta}\n  </head>`);
}

async function sendBrowserIndex(response) {
  const indexPath = path.join(__dirname, "public", "index.html");
  const html = await fs.readFile(indexPath, "utf8");
  response.type("html").send(createBrowserIndexHtml(html, browserServerToken));
}

function requireBrowserServerToken(request, response, next) {
  if (request.get("X-Rate-Limit-Tool-Token") !== browserServerToken) {
    response.status(403).json({ error: "Invalid local session token." });
    return;
  }

  next();
}

app.get(["/", "/index.html"], async (request, response) => {
  try {
    await sendBrowserIndex(response);
  } catch (error) {
    response.status(500).send(error.message);
  }
});
app.get("/history.html", async (request, response) => {
  try {
    const html = await fs.readFile(path.join(__dirname, "public", "history.html"), "utf8");
    response.type("html").send(createBrowserIndexHtml(html, browserServerToken));
  } catch (error) {
    response.status(500).send(error.message);
  }
});
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.use("/api", requireBrowserServerToken);

function defaultConfig() {
  return {
    identities: [
      {
        id: "claude-1",
        type: "claude",
        label: "Claude Code",
        workspace: defaultWorkspace
      }
    ],
    scanRoots: { claude: [], codex: [] }
  };
}

// User-configured extra folders to scan for transcripts, per CLI. Coerces to two
// string arrays, expands ~, trims, and dedupes. Unknown keys are dropped.
function normalizeScanRoots(raw) {
  const pick = (value) =>
    Array.isArray(value)
      ? [...new Set(
          value
            .filter((entry) => typeof entry === "string" && entry.trim())
            .map((entry) => expandHome(entry.trim()))
        )]
      : [];
  return { claude: pick(raw?.claude), codex: pick(raw?.codex) };
}

function expandHome(input) {
  if (!input) {
    return input;
  }

  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return path.resolve(input);
}

function compactHome(input) {
  const home = os.homedir();

  if (!input) {
    return input;
  }

  if (input === home) {
    return "~";
  }

  if (input.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, input)}`;
  }

  return input;
}

function safeSegment(value) {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return cleaned || "unknown";
}

function collisionSafeSegment(value) {
  const raw = String(value || "unknown");
  const prefix = safeSegment(raw).slice(0, 48);
  const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function timestampOrNull(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeLastUsage(raw, type) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  const service = firstString(raw.service) || type;
  if (service !== type) {
    return null;
  }

  const windows = type === "claude" && Array.isArray(raw.windows)
    ? raw.windows.map((window) => sanitizeClaudeUsageWindow(window, raw.fetchedAt))
    : raw.windows;

  return {
    ...raw,
    service,
    ...(windows ? { windows } : {})
  };
}

function identityType(raw) {
  return raw?.provider === "claude" || raw?.type === "claude" ? "claude" : "codex";
}

function buildIdentityId(type, identity) {
  const source = identity.providerAccountId || identity.email || identity.label || "current";
  return `${type}-${collisionSafeSegment(source)}`;
}

function normalizeIdentity(raw) {
  const base = typeof raw === "object" && raw !== null ? raw : {};
  const type = identityType(base);
  const email = typeof base.email === "string" && base.email.trim()
    ? base.email.trim()
    : typeof base.expectedEmail === "string" && base.expectedEmail.trim()
      ? base.expectedEmail.trim()
      : null;
  const providerAccountId =
    typeof base.providerAccountId === "string" && base.providerAccountId.trim()
      ? base.providerAccountId.trim()
      : typeof base.expectedProviderAccountId === "string" && base.expectedProviderAccountId.trim()
        ? base.expectedProviderAccountId.trim()
        : null;
  const label = String(base.label || "").trim();
  const id = String(base.id || buildIdentityId(type, { email, providerAccountId, label })).trim();
  const now = new Date().toISOString();

  if (!id) {
    throw new Error("Each identity needs an id.");
  }

  if (type === "codex") {
    const codeHome = expandHome(String(base.codeHome || base.authHome || "").trim());
    if (!codeHome) {
      throw new Error(`Codex identity ${id} needs an auth home path.`);
    }

    return {
      id,
      type,
      label: label || email || "Codex",
      codeHome,
      email,
      providerAccountId,
      firstSeenAt: timestampOrNull(base.firstSeenAt) || now,
      lastSeenAt: timestampOrNull(base.lastSeenAt),
      lastSuccessfulRefreshAt: timestampOrNull(base.lastSuccessfulRefreshAt),
      lastUsage: normalizeLastUsage(base.lastUsage, type)
    };
  }

  const workspace = expandHome(String(base.workspace || defaultWorkspace).trim());
  return {
    id,
    type,
    label: label || email || "Claude",
    workspace: workspace || defaultWorkspace,
    email,
    providerAccountId,
    organization: typeof base.organization === "string" && base.organization.trim()
      ? base.organization.trim()
      : null,
    firstSeenAt: timestampOrNull(base.firstSeenAt) || now,
    lastSeenAt: timestampOrNull(base.lastSeenAt),
    lastSuccessfulRefreshAt: timestampOrNull(base.lastSuccessfulRefreshAt),
    lastUsage: normalizeLastUsage(base.lastUsage, type)
  };
}

function legacyAccountToIdentity(account, index) {
  const type = identityType(account);
  const email = account.expectedEmail || account.email || null;
  const providerAccountId = account.expectedProviderAccountId || account.providerAccountId || null;
  const id = account.id || buildIdentityId(type, {
    email,
    providerAccountId,
    label: account.label || `${type}-${index + 1}`
  });

  return {
    ...account,
    id,
    email,
    providerAccountId
  };
}

function identitiesMatch(left, right) {
  if (left.type !== right.type) return false;
  const same = (key) => {
    const a = normalizeIdentityValue(left[key]);
    const b = normalizeIdentityValue(right[key]);
    return Boolean(a && b && a === b);
  };
  const leftProviderId = normalizeIdentityValue(left.providerAccountId);
  const rightProviderId = normalizeIdentityValue(right.providerAccountId);
  if (leftProviderId && rightProviderId) {
    return leftProviderId === rightProviderId;
  }
  return same("id") || same("email");
}

function identityWasRemoved(identity) {
  return [...removedIdentities.values()].some((removed) => identitiesMatch(removed, identity));
}

function mergeIdentity(existing, incoming) {
  return {
    ...existing,
    ...Object.fromEntries(
      Object.entries(incoming).filter(([, value]) => value !== null && value !== undefined && value !== "")
    ),
    id: existing.id,
    type: existing.type,
    label: existing.label || incoming.label,
    codeHome: existing.type === "codex" ? existing.codeHome || incoming.codeHome : undefined,
    workspace: existing.type === "claude" ? existing.workspace || incoming.workspace : undefined,
    firstSeenAt: existing.firstSeenAt || incoming.firstSeenAt
  };
}

function isLegacyDefaultCodexPlaceholder(identity) {
  if (identity.type !== "codex" || identity.email || identity.providerAccountId) {
    return false;
  }

  const codeHome = expandHome(identity.codeHome);
  return (
    (identity.id === "codex-1" && codeHome === defaultCodexHome) ||
    (identity.id === "codex-2" && codeHome === legacySecondCodexHome)
  );
}

function mergeIdentities(identities) {
  const merged = [];
  for (const identity of identities) {
    const index = merged.findIndex((candidate) => identitiesMatch(candidate, identity));
    if (index >= 0) {
      merged[index] = mergeIdentity(merged[index], identity);
    } else {
      merged.push(identity);
    }
  }
  return merged;
}

function makeIdentityIdsUnique(identities) {
  const usedIds = new Set();

  return identities.map((identity) => {
    let id = identity.id;

    if (usedIds.has(id)) {
      const baseId = buildIdentityId(identity.type, identity);
      id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
    }

    usedIds.add(id);
    return id === identity.id ? identity : { ...identity, id };
  });
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  const hasIdentityList = Array.isArray(raw?.identities) || Array.isArray(raw?.accounts);
  const incomingIdentities = Array.isArray(raw?.identities)
    ? raw.identities
    : Array.isArray(raw?.accounts)
      ? raw.accounts.map(legacyAccountToIdentity)
      : base.identities;
  const normalized = (hasIdentityList ? incomingIdentities : base.identities)
    .map(normalizeIdentity)
    .filter((identity) => !isLegacyDefaultCodexPlaceholder(identity));

  return {
    identities: makeIdentityIdsUnique(mergeIdentities(normalized)),
    scanRoots: normalizeScanRoots(raw?.scanRoots)
  };
}

function serializeConfig(config) {
  const identities = config.identities.map((identity) => {
    const serialized = {
      ...identity
    };

    if (identity.type === "codex") {
      serialized.codeHome = compactHome(identity.codeHome);
    } else {
      serialized.workspace = compactHome(identity.workspace);
    }

    for (const key of [
      "email",
      "providerAccountId",
      "organization",
      "lastSeenAt",
      "lastSuccessfulRefreshAt",
      "lastUsage"
    ]) {
      if (!serialized[key]) {
        delete serialized[key];
      }
    }

    return serialized;
  });

  const scanRoots = config.scanRoots || { claude: [], codex: [] };
  return {
    identities,
    accounts: identities,
    scanRoots: {
      claude: (scanRoots.claude || []).map(compactHome),
      codex: (scanRoots.codex || []).map(compactHome)
    }
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function loadStoredCodexIdentities(root = codexIdentityRoot) {
  let entries;

  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const identities = [];
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const directory of directories) {
    const codeHome = path.join(root, directory);
    const authPath = path.join(codeHome, "auth.json");

    if (!existsSync(authPath)) {
      continue;
    }

    const auth = await readJsonOrNull(authPath);
    const providerAccountId = firstString(
      auth?.tokens?.account_id,
      auth?.account_id,
      auth?.account?.id
    );
    const email = firstString(
      auth?.email,
      auth?.account?.email,
      auth?.user?.email
    );
    const label = email || providerAccountId || directory;

    identities.push(normalizeIdentity({
      id: buildIdentityId("codex", { email, providerAccountId, label }),
      type: "codex",
      label,
      codeHome,
      email,
      providerAccountId
    }));
  }

  return identities;
}

async function removeManagedCodexIdentityHomes(account, root = codexIdentityRoot) {
  if (account?.type !== "codex") {
    return [];
  }

  const storedIdentities = await loadStoredCodexIdentities(root);
  const homes = [...new Set(
    storedIdentities
      .filter((identity) => identitiesMatch(account, identity))
      .map((identity) => identity.codeHome)
  )];

  await Promise.all(homes.map((home) => fs.rm(home, { recursive: true, force: true })));
  return homes;
}

async function hydrateConfigFromStoredIdentities(config, root = codexIdentityRoot) {
  const storedCodexIdentities = await loadStoredCodexIdentities(root);

  return {
    ...config,
    identities: makeIdentityIdsUnique(
      mergeIdentities([
        ...config.identities.filter((identity) => !identityWasRemoved(identity)),
        ...storedCodexIdentities.filter((identity) => !identityWasRemoved(identity))
      ])
    )
  };
}

async function ensureConfig() {
  await fs.mkdir(appDataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(appDataDir, 0o700);
  let config;

  if (!existsSync(configPath)) {
    config = defaultConfig();
  } else {
    try {
      config = normalizeConfig(JSON.parse(await fs.readFile(configPath, "utf8")));
    } catch (error) {
      try {
        config = normalizeConfig(JSON.parse(await fs.readFile(configBackupPath, "utf8")));
      } catch {
        throw new Error(`Usage Meter account settings are unreadable: ${error.message}`);
      }
    }
  }

  const normalized = await hydrateConfigFromStoredIdentities(config);
  if (existsSync(configPath)) await fs.chmod(configPath, 0o600);
  return normalized;
}

function queueConfigWrite(operation) {
  const pending = configWriteQueue.then(operation, operation);
  configWriteQueue = pending.catch(() => {});
  return pending;
}

async function writeConfig(config) {
  const normalized = normalizeConfig(config);
  await atomicWriteJson(configPath, normalized);
  await atomicWriteJson(configBackupPath, normalized);
  return normalized;
}

function saveConfig(config) {
  return queueConfigWrite(() => writeConfig(config));
}

function mergeRefreshedConfig(latestConfig, refreshedConfig) {
  return {
    ...latestConfig,
    identities: mergeIdentities([
      ...latestConfig.identities,
      ...refreshedConfig.identities.filter((identity) => !identityWasRemoved(identity))
    ])
  };
}

function saveRefreshedConfig(refreshedConfig) {
  return queueConfigWrite(async () => {
    const removedRefreshIdentities = refreshedConfig.identities.filter((identity) =>
      identityWasRemoved(identity)
    );
    await Promise.all(
      removedRefreshIdentities.map((identity) => removeManagedCodexIdentityHomes(identity))
    );
    const latestConfig = await ensureConfig();
    return writeConfig(mergeRefreshedConfig(latestConfig, refreshedConfig));
  });
}

function defaultAutomationState() {
  return {
    accounts: {}
  };
}

function normalizeAutomationState(raw) {
  const accounts = typeof raw?.accounts === "object" && raw.accounts !== null
    ? raw.accounts
    : {};

  return {
    accounts: Object.fromEntries(
      Object.entries(accounts).map(([accountId, entry]) => [
        accountId,
        {
          lastSuccessfulWindowId: typeof entry?.lastSuccessfulWindowId === "string"
            ? entry.lastSuccessfulWindowId
            : null,
          lastTriggeredAt: typeof entry?.lastTriggeredAt === "string"
            ? entry.lastTriggeredAt
            : null,
          lastAttemptedWindowId: typeof entry?.lastAttemptedWindowId === "string"
            ? entry.lastAttemptedWindowId
            : null,
          lastAttemptedAt: typeof entry?.lastAttemptedAt === "string"
            ? entry.lastAttemptedAt
            : null,
          lastError: typeof entry?.lastError === "string" ? entry.lastError : null
        }
      ])
    )
  };
}

async function ensureAutomationState() {
  await fs.mkdir(appDataDir, { recursive: true, mode: 0o700 });

  if (!existsSync(automationStatePath)) {
    const initial = defaultAutomationState();
    await atomicWriteJson(automationStatePath, initial);
    return initial;
  }

  const raw = JSON.parse(await fs.readFile(automationStatePath, "utf8"));
  const normalized = normalizeAutomationState(raw);
  await atomicWriteJson(automationStatePath, normalized);
  return normalized;
}

async function saveAutomationState(state) {
  const normalized = normalizeAutomationState(state);
  await atomicWriteJson(automationStatePath, normalized);
  return normalized;
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function execFileProcessGroupPromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeout) || 0;
    const child = execFile(
      command,
      args,
      { ...options, timeout: undefined, detached: true },
      (error, stdout, stderr) => {
        clearTimeout(timeout);
        clearTimeout(killTimeout);
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          error.timedOut = timedOut;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
    let timedOut = false;
    let killTimeout = null;
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
      killTimeout = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }, 1000);
    }, timeoutMs) : null;
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

async function openTerminalCommand(command) {
  if (process.platform !== "darwin") {
    throw new Error("Login helpers in this build only support macOS.");
  }

  const terminalScript = `bash -lc ${shellQuote(command)}`;

  await execFilePromise("osascript", [
    "-e",
    'tell application "Terminal" to activate',
    "-e",
    `tell application "Terminal" to do script ${JSON.stringify(terminalScript)}`
  ]);
}

function unixSecondsToIso(value) {
  if (!value) {
    return null;
  }

  return new Date(Number(value) * 1000).toISOString();
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function codexWindowDurationSeconds(window) {
  return positiveNumber(window?.limit_window_seconds)
    || positiveNumber(window?.window_seconds)
    || (positiveNumber(window?.window_minutes) ? positiveNumber(window.window_minutes) * 60 : null);
}

function codexWindowLabel(window, source) {
  const provided = firstString(window?.limit_name, window?.name, window?.label);
  if (provided) {
    return provided;
  }

  const durationSeconds = codexWindowDurationSeconds(window);
  if (durationSeconds === 5 * 60 * 60) {
    return "5-hour";
  }
  if (durationSeconds === 7 * 24 * 60 * 60) {
    return "weekly";
  }

  return source === "primary_window" ? "Current allowance" : "Secondary allowance";
}

function normalizeCodexRateWindows(rateLimit) {
  return [
    ["primary_window", rateLimit?.primary_window],
    ["secondary_window", rateLimit?.secondary_window]
  ].flatMap(([source, window]) => {
    if (!window || typeof window !== "object") {
      return [];
    }

    const durationSeconds = codexWindowDurationSeconds(window);
    const usedPercent = Number(window.used_percent || 0);
    return [{
      id: source,
      label: codexWindowLabel(window, source),
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetAt: unixSecondsToIso(window.reset_at || window.resets_at),
      resetAfterSeconds: Number(window.reset_after_seconds || 0),
      durationSeconds,
      source
    }];
  });
}

function toCurrencyNumber(value) {
  const normalized = String(value || "0").replace(/[^0-9.]/g, "");
  return normalized ? Number(normalized) : 0;
}

function getLastMatch(text, regex) {
  const matches = Array.from(text.matchAll(regex));
  return matches.length ? matches.at(-1) : null;
}

function decodeBase64UrlJson(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(`${base64}${padding}`, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  return parts.length >= 2 ? decodeBase64UrlJson(parts[1]) : null;
}

function codexAccessTokenNeedsRefresh(accessToken, nowMs = Date.now()) {
  if (!accessToken) {
    return true;
  }

  const expiresAtSeconds = Number(decodeJwtPayload(accessToken)?.exp || 0);

  if (!expiresAtSeconds) {
    return false;
  }

  return expiresAtSeconds * 1000 <= nowMs + codexTokenRefreshSkewMs;
}

async function fetchJsonWithTimeout(url, options, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      if (response.ok) throw error;
    }
    return { response, payload };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(timeoutMessage);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function codexUsageCredentials(auth) {
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;

  if (!accessToken || !accountId) {
    throw new Error("This saved Codex auth is incomplete. Re-run login for this account.");
  }

  return { accessToken, accountId };
}

function mergeRefreshedCodexAuth(auth, payload, now = new Date()) {
  const tokens = auth?.tokens || {};
  const refreshedTokens = payload?.tokens || {};
  const nextTokens = {
    ...tokens,
    access_token: firstString(payload?.access_token, refreshedTokens.access_token, tokens.access_token),
    refresh_token: firstString(payload?.refresh_token, refreshedTokens.refresh_token, tokens.refresh_token),
    id_token: firstString(payload?.id_token, refreshedTokens.id_token, tokens.id_token),
    account_id: firstString(
      payload?.account_id,
      payload?.account?.id,
      refreshedTokens.account_id,
      tokens.account_id
    )
  };

  return {
    ...auth,
    tokens: nextTokens,
    last_refresh: now.toISOString()
  };
}

async function refreshCodexAuth(authPath, auth) {
  const refreshToken = auth?.tokens?.refresh_token;

  if (!refreshToken) {
    throw new Error("Saved Codex auth is missing a refresh token. Re-run login for this account.");
  }

  const { response, payload } = await fetchJsonWithTimeout(
    codexOAuthTokenEndpoint,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: codexOAuthClientId
      })
    },
    codexAuthRefreshTimeoutMs,
    "Codex auth refresh timed out."
  );

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new Error("Saved Codex auth refresh was rejected. Re-run login for this account.");
  }

  if (!response.ok) {
    throw new Error(`Codex auth refresh failed with ${response.status}.`);
  }

  const nextAuth = mergeRefreshedCodexAuth(auth, payload);
  codexUsageCredentials(nextAuth);

  await atomicWriteJson(authPath, nextAuth);
  return nextAuth;
}

async function requestCodexUsage(auth) {
  const { accessToken, accountId } = codexUsageCredentials(auth);

  return fetchJsonWithTimeout(
    codexUsageEndpoint,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-ID": accountId
      }
    },
    codexUsageRequestTimeoutMs,
    "Codex usage request timed out."
  );
}

async function fetchCodexUsage(account) {
  const authPath = path.join(account.codeHome, "auth.json");

  if (!existsSync(authPath)) {
    throw new Error(`No saved Codex auth found at ${authPath}. Run login for this account first.`);
  }

  let auth = JSON.parse(await fs.readFile(authPath, "utf8"));
  let response;

  if (codexAccessTokenNeedsRefresh(auth?.tokens?.access_token)) {
    auth = await refreshCodexAuth(authPath, auth);
  }

  let requested = await requestCodexUsage(auth);
  response = requested.response;

  if (response.status === 401 || response.status === 403) {
    auth = await refreshCodexAuth(authPath, auth);
    requested = await requestCodexUsage(auth);
    response = requested.response;
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("Codex auth was rejected after refresh. Re-run login for this account.");
  }

  if (!response.ok) {
    throw new Error(`Codex usage request failed with ${response.status}.`);
  }

  const payload = requested.payload;
  const { accountId } = codexUsageCredentials(auth);
  const windows = normalizeCodexRateWindows(payload?.rate_limit);

  const additionalRateLimits = Array.isArray(payload?.additional_rate_limits)
    ? payload.additional_rate_limits.map((entry) => ({
        label: entry.limit_name || entry.metered_feature || "Additional limit",
        windows: normalizeCodexRateWindows(entry?.rate_limit),
        primaryUsedPercent: Number(entry?.rate_limit?.primary_window?.used_percent || 0),
        weeklyUsedPercent: Number(entry?.rate_limit?.secondary_window?.used_percent || 0)
      }))
    : [];

  return {
    service: "codex",
    providerAccountId: accountId,
    email: payload?.email || null,
    planType: payload?.plan_type || null,
    allowed: Boolean(payload?.rate_limit?.allowed),
    limitReached: Boolean(payload?.rate_limit?.limit_reached),
    rateLimitReachedType: payload?.rate_limit_reached_type || null,
    windows,
    credits: {
      hasCredits: Boolean(payload?.credits?.has_credits),
      unlimited: Boolean(payload?.credits?.unlimited),
      overageLimitReached: Boolean(payload?.credits?.overage_limit_reached),
      balance: Number(payload?.credits?.balance || 0)
    },
    additionalRateLimits,
    fetchedAt: new Date().toISOString()
  };
}

function parseClaudeUsageScreen(screenText, now = new Date()) {
  const compact = screenText
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  const windows = [];
  const sessionBlock = getLastBlock(
    compact,
    /Current\s*ses{1,2}(?:ion)?/gi,
    [/Current\s*we+k(?:\s*\(all\s*models\))?/i],
    /(?:Resets?|Rests?)\s*\S/i
  );
  // Claude's /status now shows multiple weekly limits — "Current week (all models)"
  // plus model-specific ones like "(Sonnet only)". The all-models limit is the real
  // weekly cap; the model-only sub-limits are often 0%. Target the all-models block
  // (ending it before the next "Current week" so it can't bleed into a 0% sub-limit),
  // and fall back to a generic "Current week" block for older single-weekly formats.
  const weekBlock =
    getLastBlock(
      compact,
      /Current\s*we+k\s*\(\s*all\s*models\s*\)/gi,
      [/Current\s*we+k/i, /Approximate/i, /Last\s*24h/i, /Extra\s*usage/i],
      /(?:Resets?|Rests?)\s*\S/i
    ) ||
    getLastBlock(
      compact,
      /Current\s*we+k(?:\s*\(all\s*models\))?/gi,
      [/Approximate/i, /Last\s*24h/i, /Extra\s*usage/i],
      /(?:Resets?|Rests?)\s*\S/i
    );
  const extraUsageMatch = getLastMatch(
    compact,
    /Extra\s*usage[\s\S]{0,180}?\$([\d.,]+)\s*\/\s*\$([\d.,]+)\s*spent[\s\S]{0,160}?Resets\s*([^\n]+)/g
  );
  const sessionWindow = extractClaudeWindow("5-hour", sessionBlock, now);
  const weekWindow = extractClaudeWindow("weekly", weekBlock, now);

  if (sessionWindow) {
    windows.push(sessionWindow);
  }

  if (weekWindow) {
    windows.push(weekWindow);
  }

  return {
    windows,
    extraUsage: extraUsageMatch
      ? {
          spent: toCurrencyNumber(extraUsageMatch[1]),
          limit: toCurrencyNumber(extraUsageMatch[2]),
          resetText: cleanClaudeResetText(extraUsageMatch[3])
        }
      : null,
    fetchedAt: now.toISOString()
  };
}

function getLastBlock(text, startRegex, endRegexes = [], preferRegex = null) {
  const starts = Array.from(text.matchAll(startRegex));

  if (!starts.length) {
    return "";
  }

  const blockAt = (startIndex) => {
    const tail = text.slice(startIndex);
    let endIndex = tail.length;
    for (const endRegex of endRegexes) {
      const endMatch = endRegex.exec(tail.slice(1));
      if (endMatch?.index !== undefined) {
        endIndex = Math.min(endIndex, endMatch.index + 1);
      }
    }
    return tail.slice(0, endIndex);
  };

  // Claude's /status renders over a PTY in several redraws. A flaky capture can end
  // on a partial trailing block — the header and percent are present but the "Resets"
  // line hasn't been drawn yet. Taking the literal last block then yields a window
  // with no reset, making the countdown disappear. When a preferRegex is given,
  // pick the last block that actually contains it (e.g. a "Resets" line), and only
  // fall back to the last block if none qualify.
  if (preferRegex) {
    for (let i = starts.length - 1; i >= 0; i--) {
      const block = blockAt(starts[i].index);
      if (preferRegex.test(block)) {
        return block;
      }
    }
  }

  return blockAt(starts.at(-1).index);
}

function extractClaudeWindow(label, block, now = new Date()) {
  if (!block) {
    return null;
  }

  const percentMatch = getLastMatch(block, /(\d+)%\s*used/g);

  if (!percentMatch) {
    return null;
  }

  const usedPercent = Number(percentMatch[1]);
  const resetMatch = getLastMatch(block, /(?:Resets?|Rests?)\s*([^\n]+)/g);
  const resetText = resetMatch ? cleanClaudeResetText(resetMatch[1]) : null;

  return sanitizeClaudeUsageWindow({
    label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetText,
    resetAt: parseClaudeResetAt(resetText, now)
  }, now);
}

function sanitizeClaudeUsageWindow(window, observedAt) {
  if (!/5[-\s]?hour|5h|session/i.test(window?.label || "") || !window?.resetAt) {
    return window;
  }

  const observedMs = observedAt instanceof Date
    ? observedAt.getTime()
    : Date.parse(observedAt);
  const resetMs = Date.parse(window.resetAt);

  if (
    Number.isFinite(observedMs) &&
    Number.isFinite(resetMs) &&
    resetMs - observedMs > claudeFiveHourResetMaxMs
  ) {
    return {
      ...window,
      resetAt: null,
      resetText: null
    };
  }

  return window;
}

function cleanClaudeResetText(value) {
  const cleaned = String(value || "")
    .replace(/\d+%\s*used.*/i, "")
    .replace(/\s*used\s*$/i, "")
    .replace(/\bM\s*y\s*(\d{1,2})\b/gi, "May $1")
    .replace(/\b([A-Z][a-z]{2})(\d{1,2})\b/g, "$1 $2")
    .replace(/(\d)(?=\()/g, "$1 ")
    .replace(/([ap]m)(?=\()/gi, "$1 ")
    .replace(/\b([A-Z][a-z]{2}\s+\d{1,2})\s+t\s+(\d)/g, "$1 at $2")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
}

function parseClaudeMonth(value) {
  const normalized = String(value || "").toLowerCase();
  const aliases = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    my: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11
  };

  return Object.prototype.hasOwnProperty.call(aliases, normalized) ? aliases[normalized] : null;
}

function parseClaudeTimeParts(value) {
  const match = String(value || "").match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i);

  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3].toLowerCase();

  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  } else if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  return { hour, minute };
}

function parseClaudeResetAt(value, now = new Date()) {
  const text = cleanClaudeResetText(value);
  const time = parseClaudeTimeParts(text);

  if (!text || !time) {
    return null;
  }

  const timeZoneMatch = text.match(/\(([^()]+)\)/);
  const timeZone = timeZoneMatch?.[1]?.trim() || null;
  if (timeZone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(now);
    } catch {
      return null;
    }
  }
  const dateMatch = text.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|My|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\b/i
  );
  const zonedParts = (date, zone) => Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23"
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
  const localParts = timeZone ? zonedParts(now, timeZone) : {
    year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate()
  };
  const zonedDate = (year, month, day) => {
    if (!timeZone) return new Date(year, month - 1, day, time.hour, time.minute, 0, 0);
    const localUtc = Date.UTC(year, month - 1, day, time.hour, time.minute, 0, 0);
    let candidate = localUtc;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const actual = zonedParts(new Date(candidate), timeZone);
      const represented = Date.UTC(
        actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second
      );
      candidate += localUtc - represented;
    }
    return new Date(candidate);
  };
  let resetDate;

  if (dateMatch) {
    const month = parseClaudeMonth(dateMatch[1]);
    const day = Number(dateMatch[2]);

    if (month === null || !day) {
      return null;
    }

    resetDate = zonedDate(localParts.year, month + 1, day);

    if (resetDate.getTime() < now.getTime() - 60000) {
      resetDate = zonedDate(localParts.year + 1, month + 1, day);
    }
  } else {
    resetDate = zonedDate(localParts.year, localParts.month, localParts.day);

    if (resetDate.getTime() < now.getTime() - 60000) {
      resetDate = zonedDate(localParts.year, localParts.month, localParts.day + 1);
    }
  }

  return resetDate.toISOString();
}

function stripTerminalControl(input) {
  return String(input)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

async function captureClaudeUsage(account) {
  const command = [
    "(",
    "sleep 2;",
    "printf '/usage\\r';",
    "sleep 6;",
    "printf '\\033';",
    "sleep 3;",
    "printf '/exit\\r';",
    "sleep 1",
    ")",
    "|",
    shellQuote(scriptBin),
    "-q",
    "/dev/null",
    shellQuote(claudeBin)
  ].join(" ");

  try {
    const workspace = await ensureClaudeWorkspace(account.id || "status");
    const { stdout } = await execFileProcessGroupPromise("/bin/zsh", ["-lc", command], {
      cwd: workspace,
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
    });
    return stripTerminalControl(stdout);
  } catch (error) {
    const stdout = error.stdout ? stripTerminalControl(error.stdout) : "";

    if (stdout && !error.timedOut) {
      return stdout;
    }

    throw new Error(
      `Claude usage automation failed. ${error.message}${error.stderr ? ` ${error.stderr}` : ""}`
    );
  }
}

async function fetchClaudeUsage(account) {
  const authStatus = await getClaudeAuthStatus(account.workspace);

  if (!authStatus.loggedIn) {
    throw new Error("Claude is not logged in on this machine. Run Claude login first.");
  }

  const usageLog = await captureClaudeUsage(account);
  const usageData = parseClaudeUsageScreen(usageLog);

  if (!usageData.windows.length) {
    throw new Error("Claude /usage screen loaded, but the limits could not be parsed.");
  }

  return {
    service: "claude",
    planType: account.planType || null,
    organization: authStatus.orgId || account.organization || null,
    email: authStatus.email || account.email || null,
    ...usageData
  };
}

async function getClaudeAuthStatus(workspace = defaultWorkspace, runCommand = execFilePromise) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { stdout } = await runCommand(claudeBin, ["auth", "status", "--json"], {
        cwd: workspace,
        timeout: 10000
      });
      return JSON.parse(stdout);
    } catch (error) {
      // Claude exits with status 1 when logged out even though --json emits a valid,
      // useful status payload. Preserve that result instead of surfacing the raw
      // child-process command failure to the user.
      for (const output of [error.stdout, error.stderr]) {
        if (!output) {
          continue;
        }

        try {
          const status = JSON.parse(output);
          if (
            status &&
            typeof status === "object" &&
            !Array.isArray(status) &&
            status.loggedIn === false
          ) {
            return status;
          }
        } catch {
          // The original process error is more actionable than a secondary parse error.
        }
      }

      if (attempt === 1) {
        throw error;
      }
    }
  }
}

async function fetchUsageForAccount(account) {
  if (account.type === "claude") {
    return fetchClaudeUsage(account);
  }

  return fetchCodexUsage(account);
}

function identityLabelFromUsage(data) {
  return data?.email || data?.providerAccountId || "unknown account";
}

function findIdentityForUsage(identities, type, data, { requireStrong = false } = {}) {
  const providerAccountId = normalizeIdentityValue(data?.providerAccountId);
  const organization = normalizeIdentityValue(data?.organization);
  const email = normalizeIdentityValue(data?.email);
  const eligible = identities.filter((identity) => identity.type === type);

  if (providerAccountId) {
    const providerMatch = eligible.find(
      (identity) => normalizeIdentityValue(identity.providerAccountId) === providerAccountId
    );
    if (providerMatch) return providerMatch;

    // Email may claim a legacy identity that has no provider id yet, but it must
    // never override a conflicting strong provider id.
    return eligible.find((identity) => (
      !normalizeIdentityValue(identity.providerAccountId)
      && email
      && normalizeIdentityValue(identity.email) === email
    )) || null;
  }

  if (organization) {
    const organizationMatches = eligible.filter(
      (identity) => normalizeIdentityValue(identity.organization) === organization
    );
    if (email) {
      return organizationMatches.find(
        (identity) => normalizeIdentityValue(identity.email) === email
      ) || eligible.find((identity) => (
        !normalizeIdentityValue(identity.organization)
        && normalizeIdentityValue(identity.email) === email
      )) || null;
    }
    if (requireStrong) return null;
    if (organizationMatches.length === 1) return organizationMatches[0];
    return null;
  }

  if (email) {
    return eligible.find((identity) => normalizeIdentityValue(identity.email) === email) || null;
  }

  return requireStrong ? null : null;
}

function usageBelongsToIdentity(identity, data) {
  const expectedProviderId = normalizeIdentityValue(identity?.providerAccountId);
  const actualProviderId = normalizeIdentityValue(data?.providerAccountId);
  if (expectedProviderId && actualProviderId) {
    return expectedProviderId === actualProviderId;
  }

  const expectedOrganization = normalizeIdentityValue(identity?.organization);
  const actualOrganization = normalizeIdentityValue(data?.organization);
  if (expectedOrganization && actualOrganization && expectedOrganization !== actualOrganization) {
    return false;
  }

  const expectedEmail = normalizeIdentityValue(identity?.email);
  const actualEmail = normalizeIdentityValue(data?.email);
  return !(expectedEmail && actualEmail && expectedEmail !== actualEmail);
}

function findUnclaimedIdentity(identities, type) {
  return identities.find((identity) => (
    identity.type === type &&
    !identity.providerAccountId &&
    !identity.email
  )) || null;
}

function codexIdentityHome(data) {
  return path.join(
    codexIdentityRoot,
    collisionSafeSegment(data?.providerAccountId || data?.email || "codex-account")
  );
}

async function copyCodexAuth(sourceHome, targetHome) {
  const sourceAuthPath = path.join(sourceHome, "auth.json");

  if (!existsSync(sourceAuthPath)) {
    return false;
  }

  await fs.mkdir(targetHome, { recursive: true, mode: 0o700 });
  await fs.chmod(targetHome, 0o700);
  const targetAuthPath = path.join(targetHome, "auth.json");
  if (path.resolve(sourceAuthPath) === path.resolve(targetAuthPath)) {
    await fs.chmod(targetAuthPath, 0o600);
    return true;
  }
  await atomicWriteFile(targetAuthPath, await fs.readFile(sourceAuthPath), { mode: 0o600 });
  return true;
}

async function persistCodexAuthForIdentity(identity, sourceHome, data) {
  const stableHome = codexIdentityHome(data);
  const source = expandHome(sourceHome);
  const target = expandHome(identity.codeHome || stableHome);
  const shouldUseStableHome = source === defaultCodexHome || target === defaultCodexHome || !identity.codeHome;
  const nextHome = shouldUseStableHome ? stableHome : target;
  const copied = await copyCodexAuth(source, nextHome);

  if (copied && identity.codeHome !== nextHome) {
    identity.codeHome = nextHome;
    return true;
  }

  return false;
}

function updateIdentityFromUsage(identity, data) {
  let changed = false;
  const now = new Date().toISOString();
  const lastUsage = normalizeLastUsage(data, identity.type);

  if (data?.email && identity.email !== data.email) {
    identity.email = data.email;
    changed = true;
  }

  if (data?.providerAccountId && identity.providerAccountId !== data.providerAccountId) {
    identity.providerAccountId = data.providerAccountId;
    changed = true;
  }

  if (data?.organization && identity.organization !== data.organization) {
    identity.organization = data.organization;
    changed = true;
  }

  if (data?.email && (!identity.label || /^codex|claude$/i.test(identity.label))) {
    identity.label = data.email;
    changed = true;
  }

  if (!identity.firstSeenAt) {
    identity.firstSeenAt = now;
    changed = true;
  }

  if (identity.lastSeenAt !== now) {
    identity.lastSeenAt = now;
    changed = true;
  }

  if (identity.lastSuccessfulRefreshAt !== now) {
    identity.lastSuccessfulRefreshAt = now;
    changed = true;
  }

  if (lastUsage && JSON.stringify(identity.lastUsage) !== JSON.stringify(lastUsage)) {
    identity.lastUsage = lastUsage;
    changed = true;
  }

  return changed;
}

function createIdentityFromUsage(type, data, extras = {}) {
  const now = new Date().toISOString();
  const identity = normalizeIdentity({
    id: buildIdentityId(type, data),
    type,
    label: data?.email || (type === "claude" ? "Claude" : "Codex"),
    email: data?.email || null,
    providerAccountId: data?.providerAccountId || null,
    organization: data?.organization || null,
    firstSeenAt: now,
    lastSeenAt: now,
    lastSuccessfulRefreshAt: now,
    lastUsage: data,
    ...extras
  });

  return identity;
}

async function discoverCurrentCodexIdentity(config) {
  try {
    const data = await fetchCodexUsage({
      id: "codex-current",
      type: "codex",
      label: "Current Codex",
      codeHome: defaultCodexHome
    });
    let identity = findIdentityForUsage(config.identities, "codex", data);
    let changed = false;

    if (!identity) {
      identity = findUnclaimedIdentity(config.identities, "codex");
    }

    if (!identity) {
      identity = createIdentityFromUsage("codex", data, {
        codeHome: codexIdentityHome(data)
      });
      config.identities.push(identity);
      changed = true;
    }

    changed = updateIdentityFromUsage(identity, data) || changed;
    changed = await persistCodexAuthForIdentity(identity, defaultCodexHome, data) || changed;

    return {
      ok: true,
      changed,
      identity,
      result: {
        accountId: identity.id,
        ok: true,
        data
      }
    };
  } catch (error) {
    return {
      ok: false,
      changed: false,
      error: error.message
    };
  }
}

async function discoverCurrentClaudeIdentity(config) {
  try {
    const data = await fetchClaudeUsage({
      id: "claude-current",
      type: "claude",
      label: "Current Claude",
      workspace: defaultWorkspace
    });
    let identity = findIdentityForUsage(config.identities, "claude", data);
    let changed = false;

    if (!identity) {
      identity = findUnclaimedIdentity(config.identities, "claude");
    }

    if (!identity) {
      identity = createIdentityFromUsage("claude", data, {
        workspace: defaultWorkspace
      });
      config.identities.push(identity);
      changed = true;
    }

    changed = updateIdentityFromUsage(identity, data) || changed;

    return {
      ok: true,
      changed,
      identity,
      result: {
        accountId: identity.id,
        ok: true,
        data
      }
    };
  } catch (error) {
    return {
      ok: false,
      changed: false,
      error: error.message
    };
  }
}

async function refreshIdentity(config, identity, cachedResult = null) {
  if (cachedResult?.ok) {
    return cachedResult;
  }

  try {
    const data = await fetchUsageForAccount(identity);
    if (!usageBelongsToIdentity(identity, data)) {
      throw new Error(`This login belongs to ${identityLabelFromUsage(data)}, not ${identity.label}.`);
    }
    updateIdentityFromUsage(identity, data);

    if (identity.type === "codex") {
      await persistCodexAuthForIdentity(identity, identity.codeHome, data);
    }

    return {
      accountId: identity.id,
      ok: true,
      data
    };
  } catch (error) {
    if (identity.lastUsage) {
      return {
        accountId: identity.id,
        ok: true,
        stale: true,
        error: error.message,
        data: {
          ...identity.lastUsage,
          stale: true,
          staleReason: error.message
        }
      };
    }

    return {
      accountId: identity.id,
      ok: false,
      error: error.message
    };
  }
}

async function refreshAccountById(accountId) {
  const config = await ensureConfig();
  const identity = config.identities.find((entry) => entry.id === accountId);

  if (!identity) {
    throw new Error("Account not found.");
  }

  const result = await refreshIdentity(config, identity);
  await saveRefreshedConfig(config);
  return result;
}

async function saveUsageForAccount(accountId, data) {
  const config = await ensureConfig();
  const identity = config.identities.find((entry) => entry.id === accountId);

  if (!identity) {
    return false;
  }

  const changed = updateIdentityFromUsage(identity, data);
  if (changed) {
    await saveRefreshedConfig(config);
  }

  return changed;
}

function rejectDuplicateCodexIdentities(results) {
  const seen = new Map();

  return results.map((result) => {
    if (!result.ok || result.data?.service !== "codex") {
      return result;
    }

    const identity = result.data.providerAccountId || result.data.email;

    if (!identity) {
      return result;
    }

    const normalizedIdentity = String(identity).toLowerCase();
    const firstAccountId = seen.get(normalizedIdentity);

    if (!firstAccountId) {
      seen.set(normalizedIdentity, result.accountId);
      return result;
    }

    return {
      accountId: result.accountId,
      ok: false,
      error: `Duplicate Codex login: this slot is using the same account as ${firstAccountId}. Re-run login for this account.`
    };
  });
}

function normalizeIdentityValue(value) {
  return String(value || "").trim().toLowerCase();
}

async function refreshAllAccounts(options = {}) {
  const config = await ensureConfig();
  const skippedTypes = new Set(options.skipAccountTypes || []);
  const skippedDiscoveryTypes = new Set(options.skipDiscoveryTypes || []);
  const onlyTypes = Array.isArray(options.onlyAccountTypes)
    ? new Set(options.onlyAccountTypes)
    : null;
  const cachedResults = new Map();
  let configChanged = false;
  let currentClaudeIdentityId = null;
  let currentClaudeLabel = null;

  if ((!onlyTypes || onlyTypes.has("codex")) && !skippedTypes.has("codex") && !skippedDiscoveryTypes.has("codex")) {
    const discovery = await discoverCurrentCodexIdentity(config);
    configChanged = discovery.changed || configChanged;
    if (discovery.ok) {
      cachedResults.set(discovery.identity.id, discovery.result);
    }
  }

  if ((!onlyTypes || onlyTypes.has("claude")) && !skippedTypes.has("claude") && !skippedDiscoveryTypes.has("claude")) {
    const discovery = await discoverCurrentClaudeIdentity(config);
    configChanged = discovery.changed || configChanged;
    if (discovery.ok) {
      currentClaudeIdentityId = discovery.identity.id;
      currentClaudeLabel = identityLabelFromUsage(discovery.result.data);
      cachedResults.set(discovery.identity.id, discovery.result);
    }
  }

  const identities = config.identities.filter((identity) => {
    if (onlyTypes && !onlyTypes.has(identity.type)) {
      return false;
    }

    return true;
  });
  const results = await Promise.all(
    identities.map(async (identity) => {
      if (skippedTypes.has(identity.type)) {
        return {
          accountId: identity.id,
          ok: false,
          error: "Skipped for fast refresh."
        };
      }

      if (identity.type === "claude" && currentClaudeIdentityId && identity.id !== currentClaudeIdentityId) {
        return {
          accountId: identity.id,
          ok: false,
          error: `Claude is currently logged in as ${currentClaudeLabel}. Run login for this account to refresh it.`
        };
      }

      return refreshIdentity(config, identity, cachedResults.get(identity.id));
    })
  );

  if (configChanged || results.some((result) => result.ok)) {
    await saveRefreshedConfig(config);
  }

  const latestConfig = await ensureConfig();

  return {
    results: rejectDuplicateCodexIdentities(results),
    refreshedAt: new Date().toISOString(),
    config: serializeConfig(latestConfig)
  };
}

function getFiveHourWindow(data) {
  if (!Array.isArray(data?.windows)) {
    return null;
  }

  return data.windows.find((window) => /5-hour/i.test(window?.label || "")) || null;
}

function getFiveHourWindowId(window) {
  if (!window) {
    return null;
  }

  return String(
    window.resetAt ||
      window.resetText ||
      `${window.label}:${window.usedPercent}:${window.remainingPercent}`
  );
}

function getUsageIdentityKey(account, data) {
  const identity = data?.providerAccountId || data?.email || account.id;
  return `${account.type}:${String(identity).toLowerCase()}`;
}

function getAutomationStateEntry(state, identityKey) {
  return state.accounts[identityKey] || {};
}

async function ensureAutomationWorkspace(accountId) {
  const workspace = path.join(automationWorkspaceRoot, accountId);
  await fs.mkdir(workspace, { recursive: true });
  return workspace;
}

async function ensureClaudeWorkspace(accountId) {
  const workspace = path.join(claudeWorkspaceRoot, safeSegment(accountId));
  await fs.mkdir(workspace, { recursive: true });
  return workspace;
}

async function triggerCodexTimer(account) {
  const workspace = await ensureAutomationWorkspace(account.id);

  const { stdout, stderr } = await execFilePromise(
    codexBin,
    [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      "-s",
      "read-only",
      "-C",
      workspace,
      timerKickPrompt
    ],
    {
      cwd: workspace,
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        CODEX_HOME: account.codeHome
      }
    }
  );

  return {
    stdout: String(stdout || "").trim(),
    stderr: String(stderr || "").trim()
  };
}

async function triggerClaudeTimer(account) {
  const workspace = await ensureClaudeWorkspace(account.id);
  const { stdout, stderr } = await execFilePromise(
    claudeBin,
    [
      "-p",
      "--output-format",
      "text",
      "--no-session-persistence",
      "--tools",
      "",
      timerKickPrompt
    ],
    {
      cwd: workspace,
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024
    }
  );

  return {
    stdout: String(stdout || "").trim(),
    stderr: String(stderr || "").trim()
  };
}

async function triggerFiveHourTimerForAccount(account) {
  if (account.type === "claude") {
    return triggerClaudeTimer(account);
  }

  return triggerCodexTimer(account);
}

function summarizeTriggerOutput(result) {
  const text = String(result?.stdout || result?.stderr || "").trim();

  if (!text) {
    return null;
  }

  if (text.length <= 160) {
    return text;
  }

  return `${text.slice(0, 157)}...`;
}

async function processAutoStartSnapshot(snapshot) {
  const config = await ensureConfig();
  const automationState = await ensureAutomationState();
  const configById = new Map(config.identities.map((account) => [account.id, account]));
  const actions = [];

  for (const result of snapshot?.results || []) {
    const account = configById.get(result.accountId);

    if (!account || !result.ok) {
      continue;
    }

    const fiveHourWindow = getFiveHourWindow(result.data);

    if (!fiveHourWindow || Number(fiveHourWindow.remainingPercent || 0) < 100) {
      continue;
    }

    const windowId = getFiveHourWindowId(fiveHourWindow);
    const identityKey = getUsageIdentityKey(account, result.data);
    const entry = getAutomationStateEntry(automationState, identityKey);

    if (
      !windowId
      || entry.lastSuccessfulWindowId === windowId
      || entry.lastAttemptedWindowId === windowId
    ) {
      continue;
    }

    const attemptedAt = new Date().toISOString();

    if (process.env.RATE_LIMIT_TOOL_AUTOSTART_DRY_RUN === "1") {
      actions.push({
        accountId: result.accountId,
        identityKey,
        ok: true,
        dryRun: true,
        windowId
      });
      continue;
    }

    automationState.accounts[identityKey] = {
      ...entry,
      lastAttemptedWindowId: windowId,
      lastAttemptedAt: attemptedAt,
      lastError: null
    };
    // Persist the reservation before invoking an action-capable CLI. If the app
    // crashes after the provider accepts the request, this window is not replayed.
    await saveAutomationState(automationState);

    try {
      const triggerResult = await triggerFiveHourTimerForAccount(account);
      automationState.accounts[identityKey] = {
        ...automationState.accounts[identityKey],
        lastSuccessfulWindowId: windowId,
        lastTriggeredAt: attemptedAt,
        lastAttemptedWindowId: windowId,
        lastAttemptedAt: attemptedAt,
        lastError: null
      };
      actions.push({
        accountId: result.accountId,
        identityKey,
        ok: true,
        windowId,
        response: summarizeTriggerOutput(triggerResult)
      });
    } catch (error) {
      automationState.accounts[identityKey] = {
        ...automationState.accounts[identityKey],
        lastAttemptedWindowId: windowId,
        lastAttemptedAt: attemptedAt,
        lastError: error.message
      };
      actions.push({
        accountId: result.accountId,
        identityKey,
        ok: false,
        windowId,
        error: error.message
      });
    }
  }

  await saveAutomationState(automationState);

  return {
    checkedAt: new Date().toISOString(),
    actions
  };
}

function codexLoginCommandForAccount(account) {
  return `mkdir -p ${shellQuote(account.codeHome)} && export CODEX_HOME=${shellQuote(account.codeHome)} && (${shellQuote(googleChromeBin)} ${shellQuote(codexDeviceAuthUrl)} >/dev/null 2>&1 &) && ${shellQuote(codexBin)} login --device-auth`;
}

async function startClaudeLoginInChrome(spawnCommand = spawn, startupGraceMs = 1500) {
  if (activeClaudeLogin) {
    return activeClaudeLogin.startup;
  }

  const child = spawnCommand(claudeBin, ["auth", "login"], {
    cwd: defaultWorkspace,
    detached: true,
    env: { ...process.env, BROWSER: googleChromeBin },
    stdio: ["pipe", "ignore", "ignore"]
  });

  const startup = new Promise((resolve, reject) => {
    let startupTimer = null;
    let startupComplete = false;
    const clearActiveLogin = () => {
      if (activeClaudeLogin?.child === child) activeClaudeLogin = null;
    };

    child.once("error", (error) => {
      clearActiveLogin();
      clearTimeout(startupTimer);
      if (!startupComplete) reject(error);
    });
    const onEarlyExit = (code, signal) => {
      clearActiveLogin();
      clearTimeout(startupTimer);
      if (startupComplete) return;
      const detail = signal ? ` (signal ${signal})` : ` (exit ${code})`;
      reject(new Error(`Claude sign-in exited before opening Google Chrome${detail}.`));
    };
    child.once("exit", onEarlyExit);
    child.once("spawn", () => {
      startupTimer = setTimeout(() => {
        startupComplete = true;
        child.stdin?.unref?.();
        child.unref();
        resolve();
      }, startupGraceMs);
    });
  });

  activeClaudeLogin = { child, startup };
  return startup;
}

async function openLoginForAccount(account) {
  if (!existsSync(googleChromeBin)) {
    throw new Error("Google Chrome is required to sign in from Usage Meter.");
  }

  if (account.type === "codex") {
    await fs.mkdir(account.codeHome, { recursive: true });
    await openTerminalCommand(codexLoginCommandForAccount(account));
    return;
  }

  await startClaudeLoginInChrome();
}

async function openLoginForAccountById(accountId) {
  const config = await ensureConfig();
  const account = config.identities.find((entry) => entry.id === accountId);

  if (!account) {
    throw new Error("Account not found.");
  }

  await openLoginForAccount(account);
  return { ok: true };
}

function removeIdentityFromConfig(config, accountId) {
  const index = config.identities.findIndex((entry) => entry.id === accountId);
  if (index < 0) {
    return null;
  }

  return {
    account: config.identities[index],
    config: {
      ...config,
      identities: config.identities.filter((entry, entryIndex) => entryIndex !== index)
    }
  };
}

async function removeAccountById(accountId) {
  return queueConfigWrite(async () => {
    const config = await ensureConfig();
    const removal = removeIdentityFromConfig(config, accountId);

    if (!removal) {
      throw new Error("Account not found.");
    }

    const { account } = removal;
    removedIdentities.set(account.id, account);
    let saved;

    try {
      await removeManagedCodexIdentityHomes(account);
      saved = await writeConfig(removal.config);
    } catch (error) {
      removedIdentities.delete(account.id);
      throw error;
    }

    return {
      config: serializeConfig(saved),
      appDataDir: compactHome(appDataDir)
    };
  });
}

async function getState() {
  const config = await ensureConfig();
  return {
    config: serializeConfig(config),
    appDataDir: compactHome(appDataDir)
  };
}

app.get("/api/state", async (request, response) => {
  try {
    response.json(await getState());
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/accounts", async (request, response) => {
  try {
    const saved = await saveConfig(request.body);
    response.json({
      config: serializeConfig(saved),
      appDataDir: compactHome(appDataDir)
    });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/accounts/:id/login", async (request, response) => {
  try {
    response.json(await openLoginForAccountById(request.params.id));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.delete("/api/accounts/:id", async (request, response) => {
  try {
    response.json(await removeAccountById(request.params.id));
  } catch (error) {
    const status = error.message === "Account not found." ? 404 : 500;
    response.status(status).json({ error: error.message });
  }
});

app.post("/api/refresh", async (request, response) => {
  try {
    response.json(await refreshAllAccounts());
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/usage-history", async (request, response) => {
  try {
    const { scanUsageHistory } = require("./usage-history/aggregate");
    const rangeDays = [7, 30, 90].includes(Number(request.query.rangeDays)) ? Number(request.query.rangeDays) : 30;
    const config = await ensureConfig();
    const sr = config.scanRoots || { claude: [], codex: [] };
    const extraRoots = { claude: (sr.claude || []).map(expandHome), codex: (sr.codex || []).map(expandHome) };
    response.json(scanUsageHistory({ homeDir: os.homedir(), dataDir: appDataDir, rangeDays, extraRoots }));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

async function startServer() {
  await ensureConfig();
  app.listen(port, browserServerHost, () => {
    console.log(`Usage Meter running at http://${browserServerHost}:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  getState,
  saveConfig,
  expandHome,
  compactHome,
  refreshAccountById,
  refreshAllAccounts,
  saveUsageForAccount,
  findIdentityForUsage,
  getClaudeAuthStatus,
  processAutoStartSnapshot,
  openLoginForAccountById,
  removeAccountById,
  startServer,
  _test: {
    defaultConfig,
    normalizeConfig,
    makeIdentityIdsUnique,
    normalizeScanRoots,
    serializeConfig,
    buildIdentityId,
    codexIdentityHome,
    copyCodexAuth,
    mergeRefreshedConfig,
    findIdentityForUsage,
    usageBelongsToIdentity,
    createBrowserIndexHtml,
    codexLoginCommandForAccount,
    startClaudeLoginInChrome,
    getActiveClaudeLoginProcess: () => activeClaudeLogin?.child || null,
    loadStoredCodexIdentities,
    removeManagedCodexIdentityHomes,
    hydrateConfigFromStoredIdentities,
    removedIdentities,
    removeIdentityFromConfig,
    refreshIdentity,
    codexUsageRequestTimeoutMs,
    codexAccessTokenNeedsRefresh,
    mergeRefreshedCodexAuth,
    fetchCodexUsage,
    normalizeCodexRateWindows,
    parseClaudeResetAt,
    parseClaudeUsageScreen
  }
};
