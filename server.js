const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { existsSync } = require("fs");
const { execFile } = require("child_process");
const crypto = require("crypto");

const app = express();
const port = Number(process.env.PORT || 4545);
const appDataDir = path.join(os.homedir(), ".rate-limit-tool");
const configPath = path.join(appDataDir, "accounts.json");
const automationStatePath = path.join(appDataDir, "automation-state.json");
const automationWorkspaceRoot = path.join(appDataDir, "automation-workspaces");
const claudeWorkspaceRoot = path.join(appDataDir, "claude-workspaces");
const codexIdentityRoot = path.join(appDataDir, "codex-identities");
const defaultCodexHome = path.join(os.homedir(), ".codex");
const defaultSecondCodexHome = path.join(appDataDir, "codex-account-2");
const defaultWorkspace = process.cwd();
const timerKickPrompt = "Reply with exactly OK.";
const browserServerHost = "127.0.0.1";
const browserServerToken = crypto.randomBytes(32).toString("base64url");

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
const scriptBin = resolveExecutable("script", ["/usr/bin/script"]);
const codexUsageRequestTimeoutMs = 800;

app.use(express.json());

async function sendBrowserIndex(response) {
  const indexPath = path.join(__dirname, "public", "index.html");
  const html = await fs.readFile(indexPath, "utf8");
  const tokenScript = `<script>window.__RATE_LIMIT_SERVER_TOKEN__=${JSON.stringify(browserServerToken)};</script>`;
  response.type("html").send(html.replace("</head>", `${tokenScript}\n  </head>`));
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
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.use("/api", requireBrowserServerToken);

function defaultConfig() {
  return {
    identities: [
      {
        id: "codex-1",
        type: "codex",
        label: "Codex Account 1",
        codeHome: defaultCodexHome
      },
      {
        id: "codex-2",
        type: "codex",
        label: "Codex Account 2",
        codeHome: defaultSecondCodexHome
      },
      {
        id: "claude-1",
        type: "claude",
        label: "Claude Code",
        workspace: defaultWorkspace
      }
    ]
  };
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

function timestampOrNull(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function identityType(raw) {
  return raw?.provider === "claude" || raw?.type === "claude" ? "claude" : "codex";
}

function buildIdentityId(type, identity) {
  const source = identity.providerAccountId || identity.email || identity.label || "current";
  return `${type}-${safeSegment(source)}`;
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
      lastSuccessfulRefreshAt: timestampOrNull(base.lastSuccessfulRefreshAt)
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
    lastSuccessfulRefreshAt: timestampOrNull(base.lastSuccessfulRefreshAt)
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

function identityDedupKey(identity) {
  const identityValue = identity.providerAccountId || identity.email || identity.id;
  return `${identity.type}:${String(identityValue).trim().toLowerCase()}`;
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

function normalizeConfig(raw) {
  const base = defaultConfig();
  const incomingIdentities = Array.isArray(raw?.identities)
    ? raw.identities
    : Array.isArray(raw?.accounts)
      ? raw.accounts.map(legacyAccountToIdentity)
      : base.identities;
  const normalized = (incomingIdentities.length ? incomingIdentities : base.identities)
    .map(normalizeIdentity);
  const byKey = new Map();

  for (const identity of normalized) {
    const key = identityDedupKey(identity);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, mergeIdentity(existing, identity));
    } else {
      byKey.set(key, identity);
    }
  }

  return {
    identities: Array.from(byKey.values())
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
      "lastSuccessfulRefreshAt"
    ]) {
      if (!serialized[key]) {
        delete serialized[key];
      }
    }

    return serialized;
  });

  return {
    identities,
    accounts: identities
  };
}

async function ensureConfig() {
  await fs.mkdir(appDataDir, { recursive: true });

  if (!existsSync(configPath)) {
    const initial = defaultConfig();
    await fs.writeFile(configPath, JSON.stringify(initial, null, 2));
    return initial;
  }

  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  const normalized = normalizeConfig(raw);
  await fs.writeFile(configPath, JSON.stringify(normalized, null, 2));
  return normalized;
}

async function saveConfig(config) {
  const normalized = normalizeConfig(config);
  await fs.mkdir(appDataDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(normalized, null, 2));
  return normalized;
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
  await fs.mkdir(appDataDir, { recursive: true });

  if (!existsSync(automationStatePath)) {
    const initial = defaultAutomationState();
    await fs.writeFile(automationStatePath, JSON.stringify(initial, null, 2));
    return initial;
  }

  const raw = JSON.parse(await fs.readFile(automationStatePath, "utf8"));
  const normalized = normalizeAutomationState(raw);
  await fs.writeFile(automationStatePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

async function saveAutomationState(state) {
  const normalized = normalizeAutomationState(state);
  await fs.mkdir(appDataDir, { recursive: true });
  await fs.writeFile(automationStatePath, JSON.stringify(normalized, null, 2));
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

function toCurrencyNumber(value) {
  const normalized = String(value || "0").replace(/[^0-9.]/g, "");
  return normalized ? Number(normalized) : 0;
}

function getLastMatch(text, regex) {
  const matches = Array.from(text.matchAll(regex));
  return matches.length ? matches.at(-1) : null;
}

function labelPattern(label) {
  return label.trim().split(/\s+/).join("\\s*");
}

function extractClaudeField(screenText, label, nextLabels = []) {
  const stops = nextLabels.map((entry) => `${labelPattern(entry)}:`);
  const regex = new RegExp(
    `${labelPattern(label)}:\\s*([\\s\\S]{0,240}?)(?=${stops.join("|")}|\\n|$)`,
    "gi"
  );
  const value = getLastMatch(screenText, regex)?.[1];
  return cleanClaudeFieldValue(value);
}

function cleanClaudeFieldValue(value) {
  const cleaned = String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b(Pro|Max|Team|Enterprise|Free)(account|subscription)\b/gi, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
}

async function fetchCodexUsage(account) {
  const authPath = path.join(account.codeHome, "auth.json");

  if (!existsSync(authPath)) {
    throw new Error(`No auth.json found at ${authPath}. Run login for this account first.`);
  }

  const auth = JSON.parse(await fs.readFile(authPath, "utf8"));
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;

  if (!accessToken || !accountId) {
    throw new Error("This Codex home does not have the access token and account id needed for usage lookup.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), codexUsageRequestTimeoutMs);
  let response;

  try {
    response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-ID": accountId
      }
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Codex usage request timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("Codex auth was rejected. Re-run login for this account.");
  }

  if (!response.ok) {
    throw new Error(`Codex usage request failed with ${response.status}.`);
  }

  const payload = await response.json();
  const primary = payload?.rate_limit?.primary_window;
  const secondary = payload?.rate_limit?.secondary_window;

  const windows = [];

  if (primary) {
    windows.push({
      label: "5-hour",
      usedPercent: Number(primary.used_percent || 0),
      remainingPercent: Math.max(0, 100 - Number(primary.used_percent || 0)),
      resetAt: unixSecondsToIso(primary.reset_at),
      resetAfterSeconds: Number(primary.reset_after_seconds || 0),
      source: "primary_window"
    });
  }

  if (secondary) {
    windows.push({
      label: "weekly",
      usedPercent: Number(secondary.used_percent || 0),
      remainingPercent: Math.max(0, 100 - Number(secondary.used_percent || 0)),
      resetAt: unixSecondsToIso(secondary.reset_at),
      resetAfterSeconds: Number(secondary.reset_after_seconds || 0),
      source: "secondary_window"
    });
  }

  const additionalRateLimits = Array.isArray(payload?.additional_rate_limits)
    ? payload.additional_rate_limits.map((entry) => ({
        label: entry.limit_name || entry.metered_feature || "Additional limit",
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

function parseClaudeStatusScreen(screenText) {
  return {
    service: "claude",
    planType: extractClaudeField(screenText, "Login method", ["Organization", "Email"]),
    organization: extractClaudeField(screenText, "Organization", ["Email", "Account"]),
    email: extractClaudeField(screenText, "Email", ["Account", "Status", "Config", "Usage"])
  };
}

function parseClaudeUsageScreen(screenText) {
  const compact = screenText
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  const windows = [];
  const sessionBlock = getLastBlock(
    compact,
    /Current\s*ses{1,2}(?:ion)?/gi,
    [/Current\s*we+k(?:\s*\(all\s*models\))?/i]
  );
  const weekBlock = getLastBlock(
    compact,
    /Current\s*we+k(?:\s*\(all\s*models\))?/gi,
    [/Approximate/i, /Last\s*24h/i, /Extra\s*usage/i]
  );
  const extraUsageMatch = getLastMatch(
    compact,
    /Extra\s*usage[\s\S]{0,180}?\$([\d.,]+)\s*\/\s*\$([\d.,]+)\s*spent[\s\S]{0,160}?Resets\s*([^\n]+)/g
  );
  const sessionWindow = extractClaudeWindow("5-hour", sessionBlock);
  const weekWindow = extractClaudeWindow("weekly", weekBlock);

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
    fetchedAt: new Date().toISOString()
  };
}

function getLastBlock(text, startRegex, endRegexes = []) {
  const starts = Array.from(text.matchAll(startRegex));

  if (!starts.length) {
    return "";
  }

  const startIndex = starts.at(-1).index;
  const tail = text.slice(startIndex);
  let endIndex = tail.length;

  for (const endRegex of endRegexes) {
    const endMatch = endRegex.exec(tail.slice(1));
    if (endMatch?.index !== undefined) {
      endIndex = Math.min(endIndex, endMatch.index + 1);
    }
  }

  return tail.slice(0, endIndex);
}

function extractClaudeWindow(label, block) {
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

  return {
    label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetText,
    resetAt: parseClaudeResetAt(resetText)
  };
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

  const dateMatch = text.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|My|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\b/i
  );
  const year = now.getFullYear();
  let resetDate;

  if (dateMatch) {
    const month = parseClaudeMonth(dateMatch[1]);
    const day = Number(dateMatch[2]);

    if (month === null || !day) {
      return null;
    }

    resetDate = new Date(year, month, day, time.hour, time.minute, 0, 0);

    if (resetDate.getTime() < now.getTime() - 60000) {
      resetDate = new Date(year + 1, month, day, time.hour, time.minute, 0, 0);
    }
  } else {
    resetDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      time.hour,
      time.minute,
      0,
      0
    );

    if (resetDate.getTime() < now.getTime() - 60000) {
      resetDate = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        time.hour,
        time.minute,
        0,
        0
      );
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

async function captureClaudeStatus(account) {
  const command = [
    "(",
    "sleep 2;",
    "printf '/status\\r';",
    "sleep 1;",
    "printf '\\033[C';",
    "sleep 1;",
    "printf '\\033[C';",
    "sleep 5;",
    "printf '\\033';",
    "sleep 1;",
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
    const { stdout } = await execFilePromise("/bin/zsh", ["-lc", command], {
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

    if (stdout) {
      return stdout;
    }

    throw new Error(
      `Claude status automation failed. ${error.message}${error.stderr ? ` ${error.stderr}` : ""}`
    );
  }
}

async function fetchClaudeUsage(account) {
  const authStatus = await getClaudeAuthStatus(account.workspace);

  if (!authStatus.loggedIn) {
    throw new Error("Claude is not logged in on this machine. Run Claude login first.");
  }

  const statusLog = await captureClaudeStatus(account);
  const statusData = parseClaudeStatusScreen(statusLog);
  const usageData = parseClaudeUsageScreen(statusLog);

  if (!usageData.windows.length) {
    throw new Error("Claude usage screen loaded, but the limits could not be parsed.");
  }

  return {
    ...statusData,
    ...usageData
  };
}

async function getClaudeAuthStatus(workspace = defaultWorkspace) {
  const { stdout } = await execFilePromise(claudeBin, ["auth", "status", "--json"], {
    cwd: workspace,
    timeout: 2000
  });
  return JSON.parse(stdout);
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

function findIdentityForUsage(identities, type, data) {
  const providerAccountId = normalizeIdentityValue(data?.providerAccountId);
  const email = normalizeIdentityValue(data?.email);

  return identities.find((identity) => {
    if (identity.type !== type) {
      return false;
    }

    if (providerAccountId && normalizeIdentityValue(identity.providerAccountId) === providerAccountId) {
      return true;
    }

    return Boolean(email && normalizeIdentityValue(identity.email) === email);
  }) || null;
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
    safeSegment(data?.email || data?.providerAccountId || "codex-account")
  );
}

async function copyCodexAuth(sourceHome, targetHome) {
  const sourceAuthPath = path.join(sourceHome, "auth.json");

  if (!existsSync(sourceAuthPath)) {
    return false;
  }

  await fs.mkdir(targetHome, { recursive: true });
  await fs.copyFile(sourceAuthPath, path.join(targetHome, "auth.json"));
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
  await saveConfig(config);
  return result;
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
  const onlyTypes = Array.isArray(options.onlyAccountTypes)
    ? new Set(options.onlyAccountTypes)
    : null;
  const cachedResults = new Map();
  let configChanged = false;
  let currentClaudeIdentityId = null;
  let currentClaudeLabel = null;

  if ((!onlyTypes || onlyTypes.has("codex")) && !skippedTypes.has("codex")) {
    const discovery = await discoverCurrentCodexIdentity(config);
    configChanged = discovery.changed || configChanged;
    if (discovery.ok) {
      cachedResults.set(discovery.identity.id, discovery.result);
    }
  }

  if ((!onlyTypes || onlyTypes.has("claude")) && !skippedTypes.has("claude")) {
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
    await saveConfig(config);
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

    if (!windowId || entry.lastSuccessfulWindowId === windowId) {
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

    try {
      const triggerResult = await triggerFiveHourTimerForAccount(account);
      automationState.accounts[identityKey] = {
        ...entry,
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
        ...entry,
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

async function openLoginForAccount(account) {
  if (account.type === "codex") {
    await fs.mkdir(account.codeHome, { recursive: true });
    await openTerminalCommand(
      `mkdir -p ${shellQuote(account.codeHome)} && export CODEX_HOME=${shellQuote(account.codeHome)} && ${shellQuote(codexBin)} login`
    );
    return;
  }

  await openTerminalCommand(`${shellQuote(claudeBin)} auth login`);
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

app.post("/api/refresh", async (request, response) => {
  try {
    response.json(await refreshAllAccounts());
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
  refreshAccountById,
  refreshAllAccounts,
  getClaudeAuthStatus,
  processAutoStartSnapshot,
  openLoginForAccountById,
  startServer,
  _test: {
    defaultConfig,
    normalizeConfig,
    serializeConfig,
    parseClaudeResetAt
  }
};
