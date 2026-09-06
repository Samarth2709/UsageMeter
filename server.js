const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { existsSync } = require("fs");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const { atomicWriteFile, atomicWriteJson } = require("./atomic-file");
const { coerceResetAt } = require("./usage-windows");

const app = express();
const port = Number(process.env.PORT || 4545);
const appDataDir = path.join(os.homedir(), ".rate-limit-tool");
const configPath = path.join(appDataDir, "accounts.json");
const configBackupPath = `${configPath}.bak`;
const automationStatePath = path.join(appDataDir, "automation-state.json");
const automationWorkspaceRoot = path.join(appDataDir, "automation-workspaces");
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
let activeClaudeLoginRestart = null;
const claudeLoginCompletionListeners = new Set();
let claudeWebProvider = null;

// Electron owns the web session; the standalone HTTP server retains its OAuth reader.
function setClaudeWebProvider(provider) {
  claudeWebProvider = provider;
}

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
const codexUsageEndpoint = "https://chatgpt.com/backend-api/wham/usage";
const codexOAuthTokenEndpoint = "https://auth.openai.com/oauth/token";
const codexOAuthClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const codexUsageRequestTimeoutMs = 10000;
const codexAuthRefreshTimeoutMs = 10000;
const codexTokenRefreshSkewMs = 60000;
const claudeCredentialsService = "Claude Code-credentials";
const claudeOAuthProfileEndpoint = "https://api.anthropic.com/api/oauth/profile";
const claudeOAuthUsageEndpoint = "https://api.anthropic.com/api/oauth/usage";
const claudeOAuthBeta = "oauth-2025-04-20";
const claudeUsageRequestTimeoutMs = 10000;
// Reading Claude usage costs two requests (profile, then usage), and the
// endpoint rate-limits below the popover's one-minute refresh — a steady poll
// earns a 429 roughly every other time. Back off when one arrives instead of
// asking again on the next tick.
const claudeUsageBackoffMs = 150000;
const claudeUsageBackoffMaxMs = 15 * 60 * 1000;
// A failed poll does not make the numbers already on screen wrong. Claude's
// windows move slowly and rate limiting is routine, so keep showing the last
// reading as live until it genuinely ages out.
const usageStaleAfterMs = 6 * 60 * 1000;
const claudeFiveHourResetMaxMs = (5 * 60 * 60 * 1000) + (60 * 1000);
let claudeUsageRetryAt = 0;

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
    deletedIdentities: [],
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
      ...(base.loggedOut ? { loggedOut: true } : {}),
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
    ...(base.loggedOut ? { loggedOut: true } : {}),
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

function deletedIdentityMarker(raw) {
  const type = identityType(raw);
  return {
    id: String(raw?.id || buildIdentityId(type, raw)).trim(),
    type,
    email: firstString(raw?.email),
    providerAccountId: firstString(raw?.providerAccountId),
    organization: type === "claude" ? firstString(raw?.organization) : null
  };
}

function identityMatchesDeleted(marker, identity) {
  return identitiesMatch(marker, identity);
}

function mergeDeletedIdentities(identities) {
  const merged = [];
  for (const identity of (identities || []).map(deletedIdentityMarker)) {
    if (!merged.some((candidate) => identityMatchesDeleted(candidate, identity))) {
      merged.push(identity);
    }
  }
  return merged;
}

function identityWasDeleted(config, identity) {
  return (config.deletedIdentities || []).some((marker) => identityMatchesDeleted(marker, identity));
}

function identityWasRemoved(identity) {
  return [...removedIdentities.values()].some((removed) => identitiesMatch(removed, identity));
}

function mergeIdentity(existing, incoming) {
  const merged = {
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

  if (existing.loggedOut && !incoming.loggedOut) {
    merged.loggedOut = true;
    merged.lastSeenAt = existing.lastSeenAt;
    merged.lastSuccessfulRefreshAt = existing.lastSuccessfulRefreshAt;
    merged.lastUsage = existing.lastUsage;
  }

  return merged;
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
  const deletedIdentities = mergeDeletedIdentities(raw?.deletedIdentities || base.deletedIdentities);
  const normalized = (hasIdentityList ? incomingIdentities : base.identities)
    .map(normalizeIdentity)
    .filter((identity) => (
      !isLegacyDefaultCodexPlaceholder(identity) &&
      !identityWasDeleted({ deletedIdentities }, identity)
    ));

  return {
    identities: makeIdentityIdsUnique(mergeIdentities(normalized)),
    deletedIdentities,
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
      "loggedOut",
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
    deletedIdentities: (config.deletedIdentities || []).map((identity) =>
      Object.fromEntries(Object.entries(identity).filter(([, value]) => value))
    ),
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

async function findManagedCodexIdentityHomes(account, root = codexIdentityRoot) {
  if (account?.type !== "codex") {
    return [];
  }

  const storedIdentities = await loadStoredCodexIdentities(root);
  const homes = [...new Set(
    storedIdentities
      .filter((identity) => identitiesMatch(account, identity))
      .map((identity) => identity.codeHome)
  )];

  return homes;
}

async function removeManagedCodexIdentityHomes(account, root = codexIdentityRoot) {
  const homes = await findManagedCodexIdentityHomes(account, root);
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
        ...storedCodexIdentities.filter((identity) => (
          !identityWasRemoved(identity) &&
          !identityWasDeleted(config, identity)
        ))
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
    ]).filter((identity) => !identityWasDeleted(latestConfig, identity))
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

async function readClaudeOAuthCredentials(
  runCommand = execFilePromise,
  nowMs = Date.now()
) {
  let stdout;

  try {
    ({ stdout } = await runCommand(
      "/usr/bin/security",
      ["find-generic-password", "-s", claudeCredentialsService, "-w"],
      { timeout: 10000, maxBuffer: 1024 * 1024, encoding: "utf8" }
    ));
  } catch {
    throw new Error("No saved Claude Code login was found. Sign in to Claude again.");
  }

  let credentials;
  try {
    credentials = JSON.parse(stdout);
  } catch {
    throw new Error("The saved Claude Code login is unreadable. Sign in to Claude again.");
  }

  const oauth = credentials?.claudeAiOauth;
  const accessToken = firstString(oauth?.accessToken);
  if (!accessToken) {
    throw new Error("The saved Claude Code login is incomplete. Sign in to Claude again.");
  }

  const expiresAt = Number(oauth?.expiresAt || 0);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= nowMs) {
    throw new Error("The saved Claude Code login has expired. Sign in to Claude again.");
  }

  // Deliberately return no refresh token. Usage Meter reads the login written by
  // Claude Code, but only Claude Code is allowed to rotate that credential.
  return {
    accessToken,
    expiresAt: expiresAt || null,
    subscriptionType: firstString(oauth?.subscriptionType),
    rateLimitTier: firstString(oauth?.rateLimitTier)
  };
}

function claudeUsageBackoffRemainingMs() {
  return Math.max(0, claudeUsageRetryAt - Date.now());
}

// `Retry-After` can be delay-seconds or an HTTP date. Fall back to a fixed wait
// when neither is usable, and never hold off longer than the cap.
function claudeUsageRetryAfterMs(retryAfter, now = Date.now()) {
  const text = String(retryAfter || "").trim();
  const seconds = Number(text);
  let waitMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;

  if (waitMs === null) {
    const retryAt = Date.parse(text);
    waitMs = Number.isFinite(retryAt) && retryAt > now ? retryAt - now : claudeUsageBackoffMs;
  }

  return Math.min(waitMs, claudeUsageBackoffMaxMs);
}

function noteClaudeUsageRateLimited(retryAfter) {
  const waitMs = claudeUsageRetryAfterMs(retryAfter);
  claudeUsageRetryAt = Date.now() + waitMs;
}

function resetClaudeUsageBackoff() {
  claudeUsageRetryAt = 0;
}

async function requestClaudeOAuthJson(
  url,
  accessToken,
  requestJson = fetchJsonWithTimeout
) {
  const requested = await requestJson(
    url,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": claudeOAuthBeta
      }
    },
    claudeUsageRequestTimeoutMs,
    "Claude usage request timed out."
  );

  if (requested.response.status === 401 || requested.response.status === 403) {
    throw new Error("The saved Claude Code login was rejected. Sign in to Claude again.");
  }

  if (requested.response.status === 429) {
    noteClaudeUsageRateLimited(requested.response.headers?.get?.("retry-after"));
  }

  if (!requested.response.ok) {
    throw new Error(`Claude usage request failed with ${requested.response.status}.`);
  }

  return requested.payload;
}

function claudeUsageWindow(label, raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const usedPercent = Number(raw.utilization);
  if (!Number.isFinite(usedPercent)) {
    return null;
  }

  const clampedUsedPercent = Math.min(100, Math.max(0, usedPercent));
  return {
    label,
    usedPercent: clampedUsedPercent,
    remainingPercent: Math.max(0, 100 - clampedUsedPercent),
    resetAt: coerceResetAt(raw.resets_at),
    source: "claude_oauth_usage"
  };
}

function parseClaudeOAuthUsage(profile, payload, credentials = {}, now = new Date()) {
  const windows = [
    claudeUsageWindow("5-hour", payload?.five_hour),
    claudeUsageWindow("weekly", payload?.seven_day)
  ].filter(Boolean);

  if (!windows.length) {
    throw new Error("Claude usage responded, but no usage windows were found.");
  }

  const providerAccountId = firstString(profile?.account?.uuid, profile?.account?.id);
  const email = firstString(profile?.account?.email, profile?.email);
  if (!providerAccountId && !email) {
    throw new Error("Claude profile responded without an account identity.");
  }

  return {
    service: "claude",
    source: "claude_oauth_usage",
    providerAccountId,
    email,
    organization: firstString(profile?.organization?.uuid, profile?.organization?.id),
    planType: firstString(
      profile?.organization?.rate_limit_tier,
      credentials.rateLimitTier,
      credentials.subscriptionType
    ),
    windows,
    extraUsage: payload?.extra_usage || null,
    fetchedAt: now.toISOString()
  };
}

async function fetchClaudeUsage(account, options = {}) {
  if (claudeWebProvider) return claudeWebProvider.read(account);
  const readCredentials = options.readCredentials || readClaudeOAuthCredentials;
  const requestJson = options.requestJson || fetchJsonWithTimeout;
  const now = options.now || new Date();

  const backoffMs = claudeUsageBackoffRemainingMs();
  if (backoffMs > 0) {
    throw new Error(`Claude is rate limiting usage requests. Retrying in ${Math.ceil(backoffMs / 1000)}s.`);
  }

  const credentials = await readCredentials();
  const profile = await requestClaudeOAuthJson(
    claudeOAuthProfileEndpoint,
    credentials.accessToken,
    requestJson
  );
  const usage = await requestClaudeOAuthJson(
    claudeOAuthUsageEndpoint,
    credentials.accessToken,
    requestJson
  );

  resetClaudeUsageBackoff();
  return parseClaudeOAuthUsage(profile, usage, credentials, now);
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

function findSingleActiveUnclaimedIdentity(identities, type) {
  const candidates = identities.filter((identity) => (
    identity.type === type &&
    !identity.loggedOut &&
    !identity.providerAccountId &&
    !identity.email
  ));

  return candidates.length === 1 ? candidates[0] : null;
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
    if (identityWasDeleted(config, { type: "codex", ...data })) {
      return { ok: false, changed: false, error: "This account was deleted from Usage Meter." };
    }
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

    if (identity.loggedOut) {
      return {
        ok: false,
        changed: false,
        error: "This Usage Meter account is logged out."
      };
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

async function discoverCurrentClaudeIdentity(config, fetchUsage = fetchClaudeUsage) {
  try {
    const data = await fetchUsage({
      id: "claude-current",
      type: "claude",
      label: "Current Claude",
      workspace: defaultWorkspace
    });

    if (identityWasDeleted(config, { type: "claude", ...data })) {
      return { ok: false, changed: false, error: "This account was deleted from Usage Meter." };
    }

    let identity = findIdentityForUsage(
      config.identities,
      "claude",
      data,
      { requireStrong: true }
    );
    let changed = false;

    if (!identity) {
      const unclaimed = config.identities.filter((candidate) => (
        candidate.type === "claude" &&
        !candidate.loggedOut &&
        !candidate.providerAccountId &&
        !candidate.email
      ));

      if (unclaimed.length > 1) {
        return {
          ok: false,
          changed: false,
          error: "Multiple unclaimed Claude rows exist. Remove the extra row before refreshing."
        };
      }

      identity = findSingleActiveUnclaimedIdentity(config.identities, "claude");
    }

    if (!identity) {
      identity = createIdentityFromUsage("claude", data, {
        workspace: defaultWorkspace
      });
      config.identities.push(identity);
      changed = true;
    }

    if (identity.loggedOut) {
      return {
        ok: false,
        changed: false,
        error: "This Usage Meter account is logged out."
      };
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

function unavailableIdentityResult(identity, error, now = Date.now(), forceStale = false) {
  if (identity.lastUsage) {
    const fetchedAt = Date.parse(identity.lastUsage.fetchedAt || "");
    const aged = !Number.isFinite(fetchedAt) || now - fetchedAt > usageStaleAfterMs;

    // Still current: present it as the live reading it is, rather than greying
    // the row out because one poll was rate limited.
    if (!aged && !forceStale) {
      return {
        accountId: identity.id,
        ok: true,
        data: identity.lastUsage
      };
    }

    return {
      accountId: identity.id,
      ok: true,
      stale: true,
      error,
      data: {
        ...identity.lastUsage,
        stale: true,
        staleReason: error
      }
    };
  }

  return {
    accountId: identity.id,
    ok: false,
    error
  };
}

async function refreshIdentity(config, identity, cachedResult = null) {
  if (identity.loggedOut) {
    return {
      accountId: identity.id,
      ok: false,
      error: "Account is logged out. Run login first."
    };
  }

  if (cachedResult) {
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
    return unavailableIdentityResult(identity, error.message, Date.now(), identity.type === "claude" && Boolean(claudeWebProvider));
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

  if ((!onlyTypes || onlyTypes.has("codex")) && !skippedTypes.has("codex") && !skippedDiscoveryTypes.has("codex")) {
    const discovery = await discoverCurrentCodexIdentity(config);
    configChanged = discovery.changed || configChanged;
    if (discovery.ok) {
      cachedResults.set(discovery.identity.id, discovery.result);
    }
  }

  const activeClaudeIdentities = config.identities.filter((identity) => (
    identity.type === "claude" && !identity.loggedOut
  ));
  if (
    activeClaudeIdentities.length &&
    !claudeWebProvider &&
    (!onlyTypes || onlyTypes.has("claude")) &&
    !skippedTypes.has("claude") &&
    !skippedDiscoveryTypes.has("claude")
  ) {
    const discovery = await discoverCurrentClaudeIdentity(config);
    configChanged = discovery.changed || configChanged;
    if (discovery.ok) {
      cachedResults.set(discovery.identity.id, discovery.result);
    }

    for (const identity of activeClaudeIdentities) {
      if (discovery.ok && identity.id === discovery.identity.id) {
        cachedResults.set(identity.id, discovery.result);
        continue;
      }

      const error = discovery.ok
        ? `The active Claude Code login belongs to ${identityLabelFromUsage(discovery.result.data)}, not ${identity.label}.`
        : discovery.error;
      cachedResults.set(identity.id, unavailableIdentityResult(identity, error));
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

    if (!account || account.type === "claude" || !result.ok) {
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
      const triggerResult = await triggerCodexTimer(account);
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

function onClaudeLoginCompleted(listener) {
  claudeLoginCompletionListeners.add(listener);
  return () => claudeLoginCompletionListeners.delete(listener);
}

function notifyClaudeLoginCompleted() {
  // A new login has to be read now, not after a backoff the old one earned.
  resetClaudeUsageBackoff();
  for (const listener of claudeLoginCompletionListeners) {
    try { listener(); } catch {}
  }
}

function spawnClaudeLoginInChrome(spawnCommand, startupGraceMs) {
  const child = spawnCommand(claudeBin, ["auth", "login"], {
    cwd: defaultWorkspace,
    detached: true,
    env: { ...process.env, BROWSER: googleChromeBin },
    stdio: ["pipe", "ignore", "ignore"]
  });
  const login = {
    child,
    startup: null,
    started: false,
    completionEligible: true
  };

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
    const onExit = (code, signal) => {
      clearActiveLogin();
      clearTimeout(startupTimer);
      if (login.completionEligible && code === 0 && !signal) {
        notifyClaudeLoginCompleted();
        if (!startupComplete) resolve();
        return;
      }
      if (startupComplete) return;
      const detail = signal ? ` (signal ${signal})` : ` (exit ${code})`;
      reject(new Error(`Claude sign-in exited before opening Google Chrome${detail}.`));
    };
    child.once("exit", onExit);
    child.once("spawn", () => {
      startupTimer = setTimeout(() => {
        startupComplete = true;
        if (activeClaudeLogin === login) activeClaudeLogin.started = true;
        child.stdin?.unref?.();
        child.unref();
        resolve();
      }, startupGraceMs);
    });
  });

  login.startup = startup;
  activeClaudeLogin = login;
  return startup;
}

function waitForClaudeLoginExit(child, signal, graceMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timer = null;
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);

    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), graceMs);
    try { child.kill(signal); } catch {}
  });
}

async function stopClaudeLogin(login, terminationGraceMs) {
  login.completionEligible = false;
  const { child } = login;
  try { child.stdin?.end(); } catch {}
  if (await waitForClaudeLoginExit(child, "SIGTERM", terminationGraceMs)) return;
  if (await waitForClaudeLoginExit(child, "SIGKILL", terminationGraceMs)) return;
  throw new Error("The previous Claude sign-in could not be stopped. Try again.");
}

async function startClaudeLoginInChrome(
  spawnCommand = spawn,
  startupGraceMs = 1500,
  terminationGraceMs = 1000
) {
  if (activeClaudeLoginRestart) return activeClaudeLoginRestart;
  if (!activeClaudeLogin) return spawnClaudeLoginInChrome(spawnCommand, startupGraceMs);
  if (!activeClaudeLogin.started) return activeClaudeLogin.startup;

  const previousLogin = activeClaudeLogin;
  const restart = (async () => {
    await stopClaudeLogin(previousLogin, terminationGraceMs);
    if (activeClaudeLogin === previousLogin) activeClaudeLogin = null;
    return spawnClaudeLoginInChrome(spawnCommand, startupGraceMs);
  })();
  activeClaudeLoginRestart = restart;

  try {
    return await restart;
  } finally {
    if (activeClaudeLoginRestart === restart) activeClaudeLoginRestart = null;
  }
}

async function openLoginForAccount(account) {
  if (account.type === "claude" && claudeWebProvider) {
    await claudeWebProvider.openLogin(account);
    return;
  }
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
  const account = await queueConfigWrite(async () => {
    const config = await ensureConfig();
    const identity = config.identities.find((entry) => entry.id === accountId);

    if (!identity) {
      throw new Error("Account not found.");
    }

    if (identity.loggedOut) {
      identity.loggedOut = false;
      await writeConfig(config);
    }

    return identity;
  });

  await openLoginForAccount(account);
  return { ok: true };
}

function loggedOutIdentity(account, removeLogin) {
  const loggedOut = {
    ...account,
    loggedOut: true,
    lastSeenAt: null,
    lastSuccessfulRefreshAt: null,
    lastUsage: null
  };

  if (!removeLogin) {
    return loggedOut;
  }

  return loggedOut;
}

async function runLogoutForAccount(
  account,
  removeLogin = false,
  runCommand = execFilePromise,
  options = {}
) {
  if (account.type === "claude") {
    if (claudeWebProvider) {
      await claudeWebProvider.logout(account, removeLogin);
      return;
    }
    const status = await getClaudeAuthStatus(account.workspace || defaultWorkspace, runCommand);
    if (!status.loggedIn) return;
    const expectedEmail = normalizeIdentityValue(account.email);
    const activeEmail = normalizeIdentityValue(status.email);
    if (!expectedEmail || !activeEmail) {
      throw new Error(`Could not verify the active Claude account for ${account.label}.`);
    }
    if (expectedEmail !== activeEmail) {
      throw new Error(`Claude is currently logged in as ${status.email}, not ${account.label}.`);
    }
    if (
      account.organization &&
      status.orgId &&
      normalizeIdentityValue(account.organization) !== normalizeIdentityValue(status.orgId)
    ) {
      throw new Error(`Claude is currently logged in to a different organization than ${account.label}.`);
    }
    await runCommand(claudeBin, ["auth", "logout"], {
      cwd: account.workspace || defaultWorkspace,
      timeout: 10000
    });
    return;
  }

  const homes = new Set([expandHome(account.codeHome)]);
  if (removeLogin) {
    const storedIdentities = options.storedIdentities || await loadStoredCodexIdentities();
    for (const identity of storedIdentities) {
      if (identitiesMatch(account, identity)) homes.add(expandHome(identity.codeHome));
    }

    const currentCodexHome = options.defaultCodexHome || defaultCodexHome;
    const defaultAuth = Object.prototype.hasOwnProperty.call(options, "defaultAuth")
      ? options.defaultAuth
      : await readJsonOrNull(path.join(currentCodexHome, "auth.json"));
    if (defaultAuth) {
      const defaultIdentity = normalizeIdentity({
        type: "codex",
        label: firstString(defaultAuth.email, defaultAuth?.account?.email, "Codex"),
        codeHome: currentCodexHome,
        email: firstString(defaultAuth.email, defaultAuth?.account?.email, defaultAuth?.user?.email),
        providerAccountId: firstString(
          defaultAuth?.tokens?.account_id,
          defaultAuth.account_id,
          defaultAuth?.account?.id
        )
      });
      if (identitiesMatch(account, defaultIdentity)) homes.add(currentCodexHome);
    }
  }

  for (const codeHome of homes) {
    await runCommand(codexBin, ["logout"], {
      timeout: 10000,
      env: {
        ...process.env,
        CODEX_HOME: codeHome
      }
    });
  }
}

async function logoutAccountById(accountId, { removeLogin = false } = {}) {
  return queueConfigWrite(async () => {
    const config = await ensureConfig();
    const index = config.identities.findIndex((entry) => entry.id === accountId);

    if (index < 0) {
      throw new Error("Account not found.");
    }

    const account = config.identities[index];
    const managedHomes = removeLogin
      ? await findManagedCodexIdentityHomes(account)
      : [];
    await runLogoutForAccount(account, removeLogin);
    if (removeLogin) {
      await Promise.all(managedHomes.map((home) => fs.rm(home, { recursive: true, force: true })));
    }
    config.identities[index] = loggedOutIdentity(account, removeLogin);
    const saved = await writeConfig(config);

    return {
      config: serializeConfig(saved),
      appDataDir: compactHome(appDataDir)
    };
  });
}

function removeIdentityFromConfig(config, accountId) {
  const index = config.identities.findIndex((entry) => entry.id === accountId);
  if (index < 0) {
    return null;
  }

  const account = config.identities[index];
  return {
    account,
    config: {
      ...config,
      deletedIdentities: mergeDeletedIdentities([
        ...(config.deletedIdentities || []),
        account
      ]),
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
      if (account.type === "claude" && claudeWebProvider) {
        await claudeWebProvider.remove(account);
      }
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

app.post("/api/accounts/:id/logout", async (request, response) => {
  try {
    response.json(await logoutAccountById(request.params.id, {
      removeLogin: Boolean(request.body?.removeLogin)
    }));
  } catch (error) {
    const status = error.message === "Account not found." ? 404 : 500;
    response.status(status).json({ error: error.message });
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
  setClaudeWebProvider,
  saveUsageForAccount,
  findIdentityForUsage,
  getClaudeAuthStatus,
  processAutoStartSnapshot,
  onClaudeLoginCompleted,
  openLoginForAccountById,
  logoutAccountById,
  removeAccountById,
  startServer,
  _test: {
    defaultConfig,
    normalizeConfig,
    deletedIdentityMarker,
    identityWasDeleted,
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
    loggedOutIdentity,
    runLogoutForAccount,
    onClaudeLoginCompleted,
    startClaudeLoginInChrome,
    getActiveClaudeLoginProcess: () => activeClaudeLogin?.child || null,
    loadStoredCodexIdentities,
    removeManagedCodexIdentityHomes,
    hydrateConfigFromStoredIdentities,
    removedIdentities,
    removeIdentityFromConfig,
    refreshIdentity,
    discoverCurrentClaudeIdentity,
    unavailableIdentityResult,
    findSingleActiveUnclaimedIdentity,
    codexUsageRequestTimeoutMs,
    codexAccessTokenNeedsRefresh,
    mergeRefreshedCodexAuth,
    fetchCodexUsage,
    readClaudeOAuthCredentials,
    requestClaudeOAuthJson,
    parseClaudeOAuthUsage,
    fetchClaudeUsage,
    claudeUsageRequestTimeoutMs,
    claudeUsageBackoffMs,
    claudeUsageBackoffMaxMs,
    claudeUsageBackoffRemainingMs,
    claudeUsageRetryAfterMs,
    resetClaudeUsageBackoff,
    usageStaleAfterMs,
    normalizeCodexRateWindows,
    parseClaudeResetAt,
    parseClaudeUsageScreen
  }
};
