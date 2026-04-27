const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { existsSync } = require("fs");
const { execFile } = require("child_process");

const app = express();
const port = Number(process.env.PORT || 4545);
const appDataDir = path.join(os.homedir(), ".rate-limit-tool");
const configPath = path.join(appDataDir, "accounts.json");
const automationStatePath = path.join(appDataDir, "automation-state.json");
const automationWorkspaceRoot = path.join(appDataDir, "automation-workspaces");
const defaultCodexHome = path.join(os.homedir(), ".codex");
const defaultSecondCodexHome = path.join(appDataDir, "codex-account-2");
const defaultWorkspace = process.cwd();
const timerKickPrompt = "Reply with exactly OK.";

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

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function defaultConfig() {
  return {
    accounts: [
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

function normalizeAccount(raw) {
  const base = typeof raw === "object" && raw !== null ? raw : {};
  const id = String(base.id || "");
  const type = base.type === "claude" ? "claude" : "codex";
  const label = String(base.label || "").trim();

  if (!id) {
    throw new Error("Each account needs an id.");
  }

  if (!label) {
    throw new Error(`Account ${id} needs a label.`);
  }

  if (type === "codex") {
    const codeHome = expandHome(String(base.codeHome || "").trim());
    if (!codeHome) {
      throw new Error(`Account ${id} needs a Codex home path.`);
    }

    return {
      id,
      type,
      label,
      codeHome
    };
  }

  const workspace = expandHome(String(base.workspace || defaultWorkspace).trim());
  return {
    id,
    type,
    label,
    workspace: workspace || defaultWorkspace
  };
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  const incomingAccounts = Array.isArray(raw?.accounts) ? raw.accounts : base.accounts;
  const normalized = incomingAccounts.map(normalizeAccount);
  const byId = new Map(normalized.map((account) => [account.id, account]));

  for (const account of base.accounts) {
    if (!byId.has(account.id)) {
      byId.set(account.id, account);
    }
  }

  return {
    accounts: Array.from(byId.values())
  };
}

function serializeConfig(config) {
  return {
    accounts: config.accounts.map((account) => {
      if (account.type === "codex") {
        return {
          ...account,
          codeHome: compactHome(account.codeHome)
        };
      }

      return {
        ...account,
        workspace: compactHome(account.workspace)
      };
    })
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

  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-ID": accountId
    }
  });

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
  const resetMatch = getLastMatch(block, /Resets?\s*([^\n]+)/g);
  const resetText = resetMatch ? cleanClaudeResetText(resetMatch[1]) : null;

  return {
    label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetText
  };
}

function cleanClaudeResetText(value) {
  const cleaned = String(value || "")
    .replace(/\d+%\s*used.*/i, "")
    .replace(/\s*used\s*$/i, "")
    .replace(/\b([A-Z][a-z]{2})(\d{1,2})\b/g, "$1 $2")
    .replace(/(\d)(?=\()/g, "$1 ")
    .replace(/\b([A-Z][a-z]{2}\s+\d{1,2})\s+t\s+(\d)/g, "$1 at $2")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
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
    shellQuote(claudeBin),
    "--dangerously-skip-permissions"
  ].join(" ");

  try {
    const { stdout } = await execFilePromise("/bin/zsh", ["-lc", command], {
      cwd: account.workspace,
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
  const { stdout } = await execFilePromise(claudeBin, ["auth", "status", "--json"], {
    cwd: account.workspace
  });
  const authStatus = JSON.parse(stdout);

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

async function fetchUsageForAccount(account) {
  if (account.type === "claude") {
    return fetchClaudeUsage(account);
  }

  return fetchCodexUsage(account);
}

async function refreshAccountById(accountId) {
  const config = await ensureConfig();
  const account = config.accounts.find((entry) => entry.id === accountId);

  if (!account) {
    throw new Error("Account not found.");
  }

  try {
    return {
      accountId,
      ok: true,
      data: await fetchUsageForAccount(account)
    };
  } catch (error) {
    return {
      accountId,
      ok: false,
      error: error.message
    };
  }
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
      error: `Duplicate Codex login: this slot is using the same account as ${firstAccountId}. Run login for this account first.`
    };
  });
}

async function refreshAllAccounts() {
  const config = await ensureConfig();
  const results = await Promise.all(
    config.accounts.map((account) => refreshAccountById(account.id))
  );

  return {
    results: rejectDuplicateCodexIdentities(results),
    refreshedAt: new Date().toISOString()
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

async function triggerClaudeTimer(account) {
  const { stdout, stderr } = await execFilePromise(
    claudeBin,
    [
      "-p",
      "--output-format",
      "text",
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
      "--tools",
      "",
      timerKickPrompt
    ],
    {
      cwd: account.workspace,
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
  const configById = new Map(config.accounts.map((account) => [account.id, account]));
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
  const account = config.accounts.find((entry) => entry.id === accountId);

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
  app.listen(port, () => {
    console.log(`Usage Meter running at http://localhost:${port}`);
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
  processAutoStartSnapshot,
  openLoginForAccountById,
  startServer
};
