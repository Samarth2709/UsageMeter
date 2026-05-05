const path = require("path");
const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const crypto = require("crypto");
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen
} = require("electron");

const {
  getState,
  saveConfig,
  refreshAllAccounts,
  saveUsageForAccount,
  getClaudeAuthStatus,
  processAutoStartSnapshot,
  openLoginForAccountById
} = require("./server");
const { coerceResetAt, mergeUsageWindows } = require("./usage-windows");

const toggleShortcut = "Control+Option+L";
const windowWidth = 344;
const compactWindowHeight = 170;
const expandedWindowHeight = 220;
const maxWindowHeight = 620;
const appDataDir = path.join(os.homedir(), ".rate-limit-tool");
const windowStatePath = path.join(appDataDir, "window-state.json");
const backgroundRefreshMs = 60000;
const claudeUsageApiPort = Number(process.env.CLAUDE_USAGE_API_PORT || 4555);
const claudeUsageUrl = process.env.CLAUDE_USAGE_URL || "https://claude.ai/settings/usage";
const claudeWebRefreshMs = 30000;
const claudeCliFallbackRefreshMs = 120000;
const autoStartEnabled = process.env.RATE_LIMIT_TOOL_AUTOSTART_ENABLED === "1";
const gotSingleInstanceLock = app.requestSingleInstanceLock();
const claudeUsageApiToken = crypto.randomBytes(32).toString("base64url");

let tray = null;
let popover = null;
let currentWindowHeight = expandedWindowHeight;
let currentRowCount = 3;
let popoverPosition = null;
let popoverPositionSaveTimer = null;
let isQuitting = false;
let latestSnapshot = null;
let refreshPromise = null;
let backgroundRefreshTimer = null;
let autoStartPromise = null;
let claudeUsageWindow = null;
let claudeLoginWindow = null;
let claudeUsageApiServer = null;
let claudeWebRefreshTimer = null;
let claudeWebRefreshPromise = null;
let claudeFallbackRefreshPromise = null;
let lastClaudeFallbackRefreshAt = 0;
let claudeWebOrgId = null;
let claudeWebUsageCache = {
  ok: false,
  status: "starting",
  error: "Claude web usage has not refreshed yet.",
  fetchedAt: null
};
const refreshMetricWindowSize = 20;
const refreshMetricSamplesByEvent = new Map();

async function buildFailureSnapshot(error) {
  const message = error instanceof Error ? error.message : "Refresh failed.";
  const state = await getState();

  return {
    refreshedAt: new Date().toISOString(),
    results: state.config.accounts.map((account) => ({
      accountId: account.id,
      ok: false,
      error: message
    }))
  };
}

function createTrayIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.png"));
  icon.setTemplateImage(true);
  return icon;
}

function createPopover() {
  const initialBounds = getPopoverBounds();
  popover = new BrowserWindow({
    width: windowWidth,
    height: currentWindowHeight,
    x: initialBounds.x,
    y: initialBounds.y,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "Usage Meter",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  popover.setAlwaysOnTop(true, "floating");
  popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popover.loadFile(path.join(__dirname, "public", "index.html"));

  popover.on("move", queueSavePopoverPosition);
  popover.on("moved", queueSavePopoverPosition);

  popover.on("blur", () => {
    if (process.env.RATE_LIMIT_TOOL_KEEP_OPEN) {
      return;
    }

    if (!isQuitting && !popover.webContents.isDevToolsOpened()) {
      queueSavePopoverPosition();
      popover.hide();
    }
  });
}

async function loadPopoverPosition() {
  try {
    const raw = JSON.parse(await fs.readFile(windowStatePath, "utf8"));
    if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) {
      popoverPosition = {
        x: Math.round(raw.x),
        y: Math.round(raw.y)
      };
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not load window position: ${error.message}`);
    }
  }
}

async function savePopoverPosition(position) {
  try {
    await fs.mkdir(appDataDir, { recursive: true });
    await fs.writeFile(
      windowStatePath,
      JSON.stringify(
        {
          x: Math.round(position.x),
          y: Math.round(position.y),
          savedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
  } catch (error) {
    console.warn(`Could not save window position: ${error.message}`);
  }
}

function queueSavePopoverPosition() {
  if (!popover || popover.isDestroyed()) {
    return;
  }

  const bounds = popover.getBounds();
  popoverPosition = {
    x: bounds.x,
    y: bounds.y
  };
  clearTimeout(popoverPositionSaveTimer);
  popoverPositionSaveTimer = setTimeout(() => {
    savePopoverPosition(popoverPosition).catch(() => {});
  }, 250);
}

function getPreferredDisplay() {
  if (!tray) {
    return screen.getPrimaryDisplay();
  }

  const trayBounds = tray.getBounds();
  if (trayBounds.width > 0 && trayBounds.height > 0) {
    return screen.getDisplayNearestPoint({
      x: Math.round(trayBounds.x),
      y: Math.round(trayBounds.y)
    });
  }

  return screen.getPrimaryDisplay();
}

function getDefaultPopoverBounds() {
  const display = getPreferredDisplay();
  const x = Math.round(display.workArea.x + display.workArea.width - windowWidth - 12);
  const y = Math.round(display.workArea.y + 12);

  return { x, y, width: windowWidth, height: currentWindowHeight };
}

function clampPopoverBounds(bounds) {
  const display = screen.getDisplayMatching({
    x: bounds.x,
    y: bounds.y,
    width: windowWidth,
    height: currentWindowHeight
  });
  const area = display.workArea;
  const maxX = area.x + area.width - windowWidth;
  const maxY = area.y + area.height - currentWindowHeight;

  return {
    x: Math.min(Math.max(Math.round(bounds.x), area.x), Math.max(area.x, maxX)),
    y: Math.min(Math.max(Math.round(bounds.y), area.y), Math.max(area.y, maxY)),
    width: windowWidth,
    height: currentWindowHeight
  };
}

function getPopoverBounds() {
  if (!popoverPosition) {
    return getDefaultPopoverBounds();
  }

  return clampPopoverBounds({
    x: popoverPosition.x,
    y: popoverPosition.y,
    width: windowWidth,
    height: currentWindowHeight
  });
}

function getWindowHeight(expanded, rowCount = currentRowCount) {
  const count = Math.max(1, Number(rowCount) || 1);
  const baseHeight = expanded ? expandedWindowHeight : compactWindowHeight;
  const rowHeight = expanded ? 57 : 43;
  const dynamicHeight = 50 + count * rowHeight;
  return Math.min(maxWindowHeight, Math.max(baseHeight, dynamicHeight));
}

function setExpandedView(expanded, rowCount = currentRowCount) {
  currentRowCount = Math.max(1, Number(rowCount) || 1);
  currentWindowHeight = getWindowHeight(expanded, currentRowCount);

  if (!popover) {
    return;
  }

  const bounds = popover.getBounds();
  popover.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: windowWidth,
    height: currentWindowHeight
  });
  queueSavePopoverPosition();
}

function showPopover() {
  const bounds = getPopoverBounds();
  popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popover.setBounds(bounds);
  popover.show();
  popover.moveTop();
  popover.focus();
  queueSavePopoverPosition();
  if (process.env.RATE_LIMIT_TOOL_DEBUG) {
    console.log("Popover visible:", popover.isVisible(), popover.getBounds());
  }
}

function togglePopover() {
  if (!popover) {
    return;
  }

  if (popover.isVisible()) {
    queueSavePopoverPosition();
    popover.hide();
    return;
  }

  showPopover();
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Usage Meter");
  tray.on("click", togglePopover);
  tray.on("right-click", () => {
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: "Show / Hide", accelerator: toggleShortcut, click: togglePopover },
        { label: "Open Claude Usage Login", click: showClaudeUsageLogin },
        { type: "separator" },
        {
          label: "Quit",
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ])
    );
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getLastTextMatch(text, regex) {
  const matches = Array.from(text.matchAll(regex));
  return matches.length ? matches.at(-1) : null;
}

function cleanResetText(value) {
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

async function getClaudeOrgId() {
  if (claudeWebOrgId) {
    return claudeWebOrgId;
  }

  const authStatus = await getClaudeAuthStatus().catch(() => null);

  if (authStatus?.orgId) {
    claudeWebOrgId = authStatus.orgId;
    return claudeWebOrgId;
  }

  claudeWebOrgId = await getClaudeOrgIdFromWebSession();
  return claudeWebOrgId;
}

function findClaudeOrgId(payload) {
  const candidates = [
    payload?.organization,
    payload?.current_organization,
    payload?.currentOrganization,
    payload?.account?.organization,
    ...(Array.isArray(payload?.organizations) ? payload.organizations : []),
    ...(Array.isArray(payload?.account?.organizations) ? payload.account.organizations : [])
  ].filter(Boolean);

  for (const candidate of candidates) {
    const id = candidate.uuid || candidate.id || candidate.organization_uuid || candidate.organizationId;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  }

  const serialized = JSON.stringify(payload || {});
  const match = serialized.match(
    /"(?:uuid|id|organization_id)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i
  );
  if (match) {
    return match[1];
  }

  return null;
}

async function ensureClaudeOrigin() {
  const window = getOrCreateClaudeUsageWindow();

  if (!/^https:\/\/claude\.ai(?:\/|$)/i.test(window.webContents.getURL())) {
    await window.loadURL("https://claude.ai/");
  }

  return window;
}

async function getClaudeOrgIdFromWebSession() {
  const window = await ensureClaudeOrigin();
  const endpoints = [
    "https://claude.ai/api/bootstrap",
    "https://claude.ai/api/organizations"
  ];

  for (const endpoint of endpoints) {
    const response = await window.webContents.executeJavaScript(
      `fetch(${JSON.stringify(endpoint)}, {
        credentials: "include",
        headers: {
          "Accept": "application/json"
        }
      }).then(async (response) => ({
        ok: response.ok,
        status: response.status,
        body: await response.text()
      }))`,
      true
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error("Claude usage API needs a web login.");
    }

    if (!response.ok) {
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new Error("Claude usage API needs a web login.");
    }

    const orgId = findClaudeOrgId(payload);
    if (orgId) {
      return orgId;
    }
  }

  throw new Error("Claude web session is logged in, but no organization id was found.");
}

function extractClaudeWebWindow(label, patterns, text) {
  for (const pattern of patterns) {
    const blockMatch = getLastTextMatch(text, pattern);

    if (!blockMatch) {
      continue;
    }

    const block = blockMatch[0];
    const percentMatch = getLastTextMatch(block, /(\d{1,3})\s*%\s*used/gi);

    if (!percentMatch) {
      continue;
    }

    const usedPercent = Math.min(100, Math.max(0, Number(percentMatch[1])));
    const resetMatch = getLastTextMatch(block, /Reset(?:s|ting)?(?:\s+at|\s+on|\s+in)?\s*([^\n]+)/gi);

    return {
      label,
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetText: resetMatch ? cleanResetText(resetMatch[1]) : null,
      source: "claude_web_usage"
    };
  }

  return null;
}

function parseClaudeUsageApiPayload(payload) {
  const windows = [];
  const fiveHour = payload?.five_hour;
  const sevenDay = payload?.seven_day;

  if (fiveHour) {
    const usedPercent = Math.min(100, Math.max(0, Number(fiveHour.utilization || 0)));
    windows.push({
      label: "5-hour",
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetAt: coerceResetAt(fiveHour.resets_at),
      source: "claude_usage_api"
    });
  }

  if (sevenDay) {
    const usedPercent = Math.min(100, Math.max(0, Number(sevenDay.utilization || 0)));
    windows.push({
      label: "weekly",
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetAt: coerceResetAt(sevenDay.resets_at),
      source: "claude_usage_api"
    });
  }

  if (!windows.length) {
    return {
      ok: false,
      status: "unparsed",
      error: "Claude usage API responded, but usage windows were not found.",
      payloadKeys: Object.keys(payload || {}),
      fetchedAt: new Date().toISOString()
    };
  }

  return {
    ok: true,
    status: "ok",
    data: {
      service: "claude",
      windows,
      extraUsage: payload?.extra_usage || null,
      fetchedAt: new Date().toISOString()
    },
    fetchedAt: new Date().toISOString()
  };
}

function parseClaudeWebUsagePage(payload) {
  const text = normalizeText(payload.text);
  const email = getLastTextMatch(text, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.[0] || null;
  const loginNeeded = /\/(?:login|logout)(?:$|[/?#])/i.test(payload.url || "") ||
    (
      /(?:log in|sign in|continue with google|continue with email)/i.test(text) &&
      !/(?:current session|current week|\d{1,3}\s*%\s*used)/i.test(text)
    );

  if (loginNeeded) {
    return {
      ok: false,
      status: "login_required",
      error: "Claude usage page needs a web login.",
      url: payload.url,
      title: payload.title,
      fetchedAt: new Date().toISOString()
    };
  }

  const sessionWindow = extractClaudeWebWindow(
    "5-hour",
    [
      /Current\s*(?:session|usage|5[-\s]?hour)[\s\S]{0,420}?(?=Current\s*week|Weekly|$)/gi,
      /5[-\s]?hour[\s\S]{0,420}?(?=Current\s*week|Weekly|$)/gi
    ],
    text
  );
  const weekWindow = extractClaudeWebWindow(
    "weekly",
    [
      /Current\s*week(?:\s*\(all\s*models\))?[\s\S]{0,420}?(?=Approximate|Extra usage|$)/gi,
      /Weekly[\s\S]{0,420}?(?=Approximate|Extra usage|$)/gi
    ],
    text
  );
  const windows = [sessionWindow, weekWindow].filter(Boolean);

  if (!windows.length) {
    return {
      ok: false,
      status: "unparsed",
      error: "Claude usage page loaded, but usage numbers were not found.",
      url: payload.url,
      title: payload.title,
      textSample: text.slice(0, 800),
      fetchedAt: new Date().toISOString()
    };
  }

  return {
    ok: true,
    status: "ok",
    data: {
      service: "claude",
      source: "claude_web_usage",
      email,
      windows,
      fetchedAt: new Date().toISOString(),
      page: {
        url: payload.url,
        title: payload.title
      }
    },
    fetchedAt: new Date().toISOString()
  };
}

function getOrCreateClaudeUsageWindow() {
  if (claudeUsageWindow && !claudeUsageWindow.isDestroyed()) {
    return claudeUsageWindow;
  }

  claudeUsageWindow = new BrowserWindow({
    width: 960,
    height: 720,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:claude-usage"
    }
  });

  claudeUsageWindow.on("closed", () => {
    claudeUsageWindow = null;
  });

  return claudeUsageWindow;
}

function showClaudeUsageLogin() {
  claudeWebOrgId = null;

  if (claudeLoginWindow && !claudeLoginWindow.isDestroyed()) {
    claudeLoginWindow.show();
    claudeLoginWindow.focus();
    return;
  }

  claudeLoginWindow = new BrowserWindow({
    width: 1080,
    height: 820,
    show: true,
    title: "Claude Usage Login",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:claude-usage"
    }
  });

  claudeLoginWindow.loadURL(claudeUsageUrl);
  claudeLoginWindow.on("closed", () => {
    claudeLoginWindow = null;
    refreshClaudeWebUsage().catch(() => {});
  });
}

async function readClaudeUsagePage() {
  const window = getOrCreateClaudeUsageWindow();
  await window.loadURL(claudeUsageUrl);
  await wait(2500);

  return window.webContents.executeJavaScript(
    `(() => ({
      url: location.href,
      title: document.title,
      text: document.body ? document.body.innerText : ""
    }))()`,
    true
  );
}

async function readClaudeUsageApi() {
  const orgId = await getClaudeOrgId();
  const window = await ensureClaudeOrigin();
  const usageUrl = `https://claude.ai/api/organizations/${orgId}/usage`;

  return window.webContents.executeJavaScript(
    `fetch(${JSON.stringify(usageUrl)}, {
      credentials: "include",
      headers: {
        "Accept": "application/json"
      }
    }).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      url: response.url,
      body: await response.text()
    }))`,
    true
  );
}

async function refreshClaudeWebUsage() {
  if (claudeWebRefreshPromise) {
    return claudeWebRefreshPromise;
  }

  claudeWebRefreshPromise = (async () => {
    try {
      const response = await readClaudeUsageApi();

      if (response.status === 401 || response.status === 403) {
        claudeWebOrgId = null;
        claudeWebUsageCache = {
          ok: false,
          status: "login_required",
          error: "Claude usage API needs a web login.",
          fetchedAt: new Date().toISOString()
        };
      } else if (!response.ok) {
        throw new Error(`Claude usage API request failed with ${response.status}.`);
      } else {
        let payload;

        try {
          payload = JSON.parse(response.body);
        } catch {
          claudeWebUsageCache = {
            ok: false,
            status: "login_required",
            error: "Claude usage API needs a web login.",
            fetchedAt: new Date().toISOString()
          };
          return claudeWebUsageCache;
        }

        claudeWebUsageCache = parseClaudeUsageApiPayload(payload);
      }
    } catch (error) {
      claudeWebUsageCache = {
        ok: false,
        status: "error",
        error: error.message,
        fetchedAt: new Date().toISOString()
      };
    }

    return claudeWebUsageCache;
  })();

  try {
    return await claudeWebRefreshPromise;
  } finally {
    claudeWebRefreshPromise = null;
  }
}

async function mergeClaudeWebUsage(snapshot) {
  if (!claudeWebUsageCache.ok || !snapshot?.results?.length) {
    return snapshot;
  }

  const state = await getState();
  const claudeAccountIds = new Set(
    state.config.accounts
      .filter((account) => account.type === "claude")
      .map((account) => account.id)
  );

  const mergedSnapshot = {
    ...snapshot,
    results: snapshot.results.map((result) => {
      if (!claudeAccountIds.has(result.accountId)) {
        return result;
      }

      const existingData = result.data || {};
      const webData = claudeWebUsageCache.data || {};

      return {
        ...result,
        ok: true,
        data: {
          ...existingData,
          ...webData,
          windows: mergeUsageWindows(existingData.windows, webData.windows),
          source: "claude_web_usage"
        }
      };
    })
  };

  await Promise.all(
    mergedSnapshot.results
      .filter((result) => result.ok && claudeAccountIds.has(result.accountId) && result.data)
      .map((result) => saveUsageForAccount(result.accountId, result.data).catch(() => false))
  );

  return mergedSnapshot;
}

async function refreshClaudeFallbackUsage() {
  if (claudeFallbackRefreshPromise) {
    return claudeFallbackRefreshPromise;
  }

  claudeFallbackRefreshPromise = (async () => {
    lastClaudeFallbackRefreshAt = Date.now();
    const startedAt = nowMs();
    const snapshot = await refreshAllAccounts({ onlyAccountTypes: ["claude"] });
    const results = snapshot.results || [];

    if (latestSnapshot?.results?.length) {
      const resultsByAccountId = new Map(results.map((result) => [result.accountId, result]));
      const existingResultIds = new Set(latestSnapshot.results.map((result) => result.accountId));
      latestSnapshot = {
        ...latestSnapshot,
        config: snapshot.config || latestSnapshot.config,
        results: [
          ...latestSnapshot.results.map((result) => resultsByAccountId.get(result.accountId) || result),
          ...results.filter((result) => !existingResultIds.has(result.accountId))
        ]
      };
      broadcastSnapshot(latestSnapshot);
    }

    logRefreshMetric({
      event: "claude_cli_refresh",
      durationMs: nowMs() - startedAt,
      resultCount: results.length,
      okCount: results.filter((result) => result.ok).length
    });

    return results;
  })();

  try {
    return await claudeFallbackRefreshPromise;
  } finally {
    claudeFallbackRefreshPromise = null;
  }
}

function shouldRefreshClaudeFallback() {
  const hasClaudeResult = latestSnapshot?.results?.some((result) => result.data?.service === "claude");

  if (!hasClaudeResult) {
    return true;
  }

  return Date.now() - lastClaudeFallbackRefreshAt >= claudeCliFallbackRefreshMs;
}

async function preserveFastClaudeResults(snapshot, previousSnapshot) {
  if (!snapshot?.results?.length || !previousSnapshot?.results?.length) {
    return snapshot;
  }

  const state = await getState();
  const claudeAccountIds = new Set(
    state.config.accounts
      .filter((account) => account.type === "claude")
      .map((account) => account.id)
  );
  const previousByAccountId = new Map(
    previousSnapshot.results.map((result) => [result.accountId, result])
  );

  return {
    ...snapshot,
    results: snapshot.results.map((result) => {
      if (!claudeAccountIds.has(result.accountId) || result.error !== "Skipped for fast refresh.") {
        return result;
      }

      return previousByAccountId.get(result.accountId) || {
        ...result,
        error: claudeWebUsageCache.error || "Claude usage API needs a web login."
      };
    })
  };
}

function preserveRecentSuccessfulResults(snapshot, previousSnapshot) {
  if (!snapshot?.results?.length || !previousSnapshot?.results?.length) {
    return snapshot;
  }

  const previousByAccountId = new Map(
    previousSnapshot.results
      .filter((result) => result.ok)
      .map((result) => [result.accountId, result])
  );

  return {
    ...snapshot,
    results: snapshot.results.map((result) => {
      if (result.ok || !/timed out/i.test(result.error || "")) {
        return result;
      }

      const previous = previousByAccountId.get(result.accountId);
      if (!previous) {
        return result;
      }

      return {
        ...previous,
        stale: true,
        staleReason: result.error
      };
    })
  };
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json"
  });
  response.end(JSON.stringify(body, null, 2));
}

function authorizeClaudeUsageApiRequest(request, response) {
  if (request.headers["x-rate-limit-tool-token"] !== claudeUsageApiToken) {
    sendJson(response, 403, { ok: false, error: "Invalid local session token." });
    return false;
  }

  return true;
}

function startClaudeUsageApiServer() {
  if (claudeUsageApiServer) {
    return;
  }

  claudeUsageApiServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${claudeUsageApiPort}`);

    if (!authorizeClaudeUsageApiRequest(request, response)) {
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/claude-web-usage") {
      const shouldRefresh = url.searchParams.get("refresh") === "1";
      sendJson(response, 200, shouldRefresh ? await refreshClaudeWebUsage() : claudeWebUsageCache);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/claude-web-usage/refresh") {
      sendJson(response, 200, await refreshClaudeWebUsage());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/claude-web-usage/login") {
      showClaudeUsageLogin();
      claudeWebUsageCache = {
        ok: false,
        status: "login_required",
        error: "Claude usage login window is open.",
        url: claudeUsageUrl,
        fetchedAt: new Date().toISOString()
      };
      sendJson(response, 200, { ok: true, url: claudeUsageUrl });
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found." });
  });

  claudeUsageApiServer.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.warn(
        `Claude web usage API port ${claudeUsageApiPort} is already in use; continuing without the helper server.`
      );
      claudeUsageApiServer = null;
      return;
    }

    console.warn(`Claude web usage API failed to start: ${error.message}`);
    claudeUsageApiServer = null;
  });

  claudeUsageApiServer.listen(claudeUsageApiPort, "127.0.0.1", () => {
    console.log(`Claude web usage API running at http://127.0.0.1:${claudeUsageApiPort}`);
  });
}

function startClaudeWebUsageRefresh() {
  clearInterval(claudeWebRefreshTimer);
  refreshClaudeWebUsage().catch(() => {});
  claudeWebRefreshTimer = setInterval(() => {
    if (claudeWebUsageCache.status === "login_required") {
      return;
    }

    refreshClaudeWebUsage().catch(() => {});
  }, claudeWebRefreshMs);
}

function broadcastSnapshot(snapshot) {
  if (!popover || popover.isDestroyed()) {
    return;
  }

  popover.webContents.send("rate-limit:snapshot", snapshot);
}

function queueAutoStart(snapshot) {
  if (!autoStartEnabled) {
    return Promise.resolve(null);
  }

  if (autoStartPromise) {
    return autoStartPromise;
  }

  autoStartPromise = processAutoStartSnapshot(snapshot)
    .then((result) => {
      for (const action of result.actions || []) {
        const status = action.dryRun ? "dry-run" : action.ok ? "triggered" : "failed";
        const detail = action.error || action.response || action.windowId || "";
        console.log(`[autostart] ${action.accountId}: ${status}${detail ? ` (${detail})` : ""}`);
      }
    })
    .catch((error) => {
      console.warn(`[autostart] ${error.message}`);
    })
    .finally(() => {
      autoStartPromise = null;
    });

  return autoStartPromise;
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function logRefreshMetric(fields) {
  const durationMs = Number(fields.durationMs);

  if (!Number.isFinite(durationMs)) {
    console.log(`[refresh-metric] ${JSON.stringify(fields)}`);
    return;
  }

  const samples = refreshMetricSamplesByEvent.get(fields.event) || [];
  samples.push(durationMs);

  if (samples.length > refreshMetricWindowSize) {
    samples.shift();
  }

  refreshMetricSamplesByEvent.set(fields.event, samples);

  const total = samples.reduce((sum, value) => sum + value, 0);
  const enrichedFields = {
    ...fields,
    stats: {
      sampleCount: samples.length,
      averageDurationMs: Math.round(total / samples.length),
      minDurationMs: Math.min(...samples),
      maxDurationMs: Math.max(...samples)
    }
  };

  console.log(`[refresh-metric] ${JSON.stringify(enrichedFields)}`);
}

async function refreshSnapshot() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const refreshStartedAt = nowMs();
    let snapshot;
    const previousSnapshot = latestSnapshot;

    const claudeStartedAt = nowMs();
    refreshClaudeWebUsage()
      .then(async () => {
        const claudeFetchMs = nowMs() - claudeStartedAt;
        if (!claudeWebUsageCache.ok && shouldRefreshClaudeFallback()) {
          refreshClaudeFallbackUsage().catch((error) => {
            logRefreshMetric({
              event: "claude_cli_refresh",
              durationMs: nowMs() - claudeStartedAt,
              status: "error",
              ok: false,
              error: error.message
            });
          });
        }

        if (!latestSnapshot) {
          logRefreshMetric({
            event: "claude_web_refresh",
            durationMs: claudeFetchMs,
            status: claudeWebUsageCache.status,
            ok: claudeWebUsageCache.ok,
            error: claudeWebUsageCache.ok ? undefined : claudeWebUsageCache.error
          });
          return;
        }

        latestSnapshot = await mergeClaudeWebUsage(latestSnapshot);
        broadcastSnapshot(latestSnapshot);
        logRefreshMetric({
          event: "claude_web_refresh",
          durationMs: claudeFetchMs,
          status: claudeWebUsageCache.status,
          ok: claudeWebUsageCache.ok,
          error: claudeWebUsageCache.ok ? undefined : claudeWebUsageCache.error
        });
      })
      .catch((error) => {
        logRefreshMetric({
          event: "claude_web_refresh",
          durationMs: nowMs() - claudeStartedAt,
          status: "error",
          ok: false,
          error: error.message
        });
      });

    const accountRefreshStartedAt = nowMs();
    try {
      snapshot = await refreshAllAccounts({ skipAccountTypes: ["claude"] });
    } catch (error) {
      snapshot = await buildFailureSnapshot(error);
    }
    const accountRefreshMs = nowMs() - accountRefreshStartedAt;

    const mergeStartedAt = nowMs();
    snapshot = preserveRecentSuccessfulResults(snapshot, previousSnapshot);
    snapshot = await preserveFastClaudeResults(snapshot, previousSnapshot);
    latestSnapshot = await mergeClaudeWebUsage(snapshot);
    const mergeMs = nowMs() - mergeStartedAt;

    broadcastSnapshot(latestSnapshot);
    queueAutoStart(latestSnapshot);
    logRefreshMetric({
      event: "manual_refresh",
      durationMs: nowMs() - refreshStartedAt,
      accountRefreshMs,
      mergeMs,
      resultCount: latestSnapshot?.results?.length || 0,
      okCount: latestSnapshot?.results?.filter((result) => result.ok).length || 0
    });
    return latestSnapshot;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function startBackgroundRefresh() {
  clearInterval(backgroundRefreshTimer);
  backgroundRefreshTimer = setInterval(() => {
    refreshSnapshot().catch(() => {});
  }, backgroundRefreshMs);
}

function registerIpcHandlers() {
  ipcMain.handle("rate-limit:get-state", () => getState());
  ipcMain.handle("rate-limit:get-snapshot", async () => latestSnapshot);
  ipcMain.handle("rate-limit:save-config", async (event, config) => {
    await saveConfig(config);
    return getState();
  });
  ipcMain.handle("rate-limit:open-login", async (event, accountId) => {
    const state = await getState();
    const account = state.config.accounts.find((entry) => entry.id === accountId);

    if (account?.type === "claude") {
      showClaudeUsageLogin();
      return { ok: true };
    }

    return openLoginForAccountById(accountId);
  });
  ipcMain.handle("rate-limit:refresh", () => refreshSnapshot());
  ipcMain.handle("rate-limit:toggle", togglePopover);
  ipcMain.on("rate-limit:set-expanded-view", (event, expanded, rowCount) => {
    setExpandedView(Boolean(expanded), rowCount);
  });
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (popover) {
      showPopover();
    }
  });

  app.whenReady().then(async () => {
    app.setName("Usage Meter");

    if (app.dock) {
      app.dock.hide();
    }

    await loadPopoverPosition();
    registerIpcHandlers();
    createPopover();
    createTray();
    popover.once("ready-to-show", showPopover);
    setTimeout(showPopover, 800);
    startBackgroundRefresh();
    startClaudeUsageApiServer();
    startClaudeWebUsageRefresh();

    const registered = globalShortcut.register(toggleShortcut, togglePopover);
    if (process.env.RATE_LIMIT_TOOL_DEBUG) {
      console.log(`Shortcut ${toggleShortcut} registered:`, registered);
    }
    if (!registered) {
      console.warn(`Could not register global shortcut ${toggleShortcut}.`);
    }
  });

  app.on("activate", () => {
    if (!popover) {
      createPopover();
    }
    showPopover();
  });
}

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  clearInterval(backgroundRefreshTimer);
  clearInterval(claudeWebRefreshTimer);
  clearTimeout(popoverPositionSaveTimer);
  if (claudeUsageApiServer) {
    claudeUsageApiServer.close();
  }
  globalShortcut.unregisterAll();
});
