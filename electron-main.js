const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  dialog
} = require("electron");

const {
  getState,
  saveConfig,
  expandHome,
  refreshAllAccounts,
  saveUsageForAccount,
  getClaudeAuthStatus,
  processAutoStartSnapshot,
  openLoginForAccountById
} = require("./server");
const { coerceResetAt, mergeUsageWindows } = require("./usage-windows");
const { scanUsageHistory } = require("./usage-history/aggregate");
const { computeWindowValues, transcriptFingerprint, clearPointsCache } = require("./usage-history/windows");
const { computeRunways } = require("./usage-history/runway");
const { buildDiagnostics } = require("./usage-history/diagnostics");

const toggleShortcut = "Control+Option+L";
const windowWidth = 344;
const compactWindowHeight = 170;
const expandedWindowHeight = 220;
const minWindowHeight = 70;
const maxWindowHeight = 620;
const appDataDir = path.join(os.homedir(), ".rate-limit-tool");
const windowStatePath = path.join(appDataDir, "window-state.json");
const launchAtLoginStateFile = "launch-at-login-enabled.json";
const backgroundRefreshMs = 60000;
const claudeUsageUrl = process.env.CLAUDE_USAGE_URL || "https://claude.ai/settings/usage";
// The claude.ai web scrape recreates a full renderer each time, so keep it infrequent.
const claudeWebRefreshMs = 300000;
const claudeCliUsageRefreshMs = 300000;
const autoStartEnabled = process.env.RATE_LIMIT_TOOL_AUTOSTART_ENABLED === "1";
const gotSingleInstanceLock = app.requestSingleInstanceLock();

let tray = null;
let popover = null;
let historyWindow = null;
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
let claudeWebRefreshTimer = null;
let claudeWebRefreshPromise = null;
let claudeCliUsageRefreshPromise = null;
let lastClaudeWebScrapeAt = 0;
let lastClaudeCliUsageRefreshAt = 0;
let claudeWebOrgId = null;
// Pre-computed usage-history payloads (rangeDays -> payload), kept warm so the
// "View usage history" window opens instantly instead of scanning transcripts on click.
let historyCache = new Map();
let historyRecomputeQueued = false;
let historyFingerprint = null;
// User-configured extra transcript folders (absolute paths), mirrored from config so
// the synchronous history path can read them without an async config load each time.
let scanRoots = { claude: [], codex: [] };
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

async function enableLaunchAtLoginByDefault() {
  if (process.platform !== "darwin" || !app.isPackaged || !app.isInApplicationsFolder()) {
    return;
  }

  const statePath = path.join(app.getPath("userData"), launchAtLoginStateFile);

  try {
    await fs.access(statePath);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read launch-at-login state: ${error.message}`);
      return;
    }
  }

  try {
    app.setLoginItemSettings({ openAtLogin: true });
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ enabledAt: new Date().toISOString() }));
  } catch (error) {
    console.warn(`Could not enable launch at login: ${error.message}`);
  }
}

function createPopover() {
  const initialBounds = getPopoverBounds();
  const window = new BrowserWindow({
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
      preload: globalThis.__usageMeterBootstrapPreloadPath || path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  popover = window;
  globalThis.__usageMeterRegisterCoreWebContents?.(window.webContents);
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.loadFile(path.join(__dirname, "public", "index.html"));

  window.on("move", queueSavePopoverPosition);
  window.on("moved", queueSavePopoverPosition);
  window.on("closed", () => {
    if (popover === window) {
      popover = null;
    }
    globalThis.__usageMeterUnregisterCoreWebContents?.(window.webContents);
  });

  // Intentionally NOT hiding on blur: combined with setVisibleOnAllWorkspaces,
  // this keeps the popover pinned to the top-right and visible on every Space /
  // desktop (it would otherwise auto-hide when a Space switch steals focus).
  // Use the menu-bar icon or Control+Option+L to hide/show it manually.
}

function ensurePopover() {
  if (!popover || popover.isDestroyed()) {
    createPopover();
  }

  return popover;
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

function getWindowHeight(expanded, rowCount = currentRowCount, contentHeight = null) {
  // Prefer the renderer's measured content height so the window hugs the
  // content with no dead space; fall back to the row-count estimate.
  const measured = Number(contentHeight);
  if (Number.isFinite(measured) && measured > 0) {
    return Math.min(maxWindowHeight, Math.max(minWindowHeight, Math.ceil(measured)));
  }

  const count = Math.max(1, Number(rowCount) || 1);
  const baseHeight = expanded ? expandedWindowHeight : compactWindowHeight;
  const rowHeight = expanded ? 57 : 43;
  const dynamicHeight = 50 + count * rowHeight;
  return Math.min(maxWindowHeight, Math.max(baseHeight, dynamicHeight));
}

function setExpandedView(expanded, rowCount = currentRowCount, contentHeight = null) {
  currentRowCount = Math.max(1, Number(rowCount) || 1);
  currentWindowHeight = getWindowHeight(expanded, currentRowCount, contentHeight);

  if (!popover || popover.isDestroyed()) {
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

function moveToTopRight() {
  if (!popover || popover.isDestroyed()) {
    return;
  }

  const bounds = getDefaultPopoverBounds();
  popover.setBounds(bounds);
  popoverPosition = { x: bounds.x, y: bounds.y };
  queueSavePopoverPosition();
}

function openHistoryWindow() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.show();
    historyWindow.focus();
    return;
  }

  historyWindow = new BrowserWindow({
    width: 880,
    height: 660,
    title: "Usage History",
    show: true,
    webPreferences: {
      preload: globalThis.__usageMeterBootstrapPreloadPath || path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  historyWindow.loadFile(path.join(__dirname, "public", "history.html"));
  historyWindow.on("closed", () => {
    historyWindow = null;
    // Free the ~payload + points caches now that nobody is viewing history.
    releaseHistoryMemory();
  });

  // Destroy (not just hide) when focus moves away, so the renderer process and its
  // heap are reclaimed instead of staying resident. Reopening recreates it — the
  // per-file points cache makes the reparse cheap within a session.
  historyWindow.on("blur", () => {
    if (process.env.RATE_LIMIT_TOOL_KEEP_OPEN) {
      return;
    }

    if (!isQuitting && !historyWindow.webContents.isDevToolsOpened()) {
      historyWindow.destroy();
    }
  });
}

function showPopover() {
  const window = ensurePopover();
  const bounds = getPopoverBounds();
  // Re-assert all-Spaces membership, then show WITHOUT activating the app.
  // Calling show()/focus() activates the window, which makes macOS jump to
  // whichever Space the window was last shown on. showInactive() simply orders
  // it onto the desktop you're currently looking at — the behavior we want for a
  // pinned top-right widget.
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setAlwaysOnTop(true, "floating");
  window.setBounds(bounds);
  window.showInactive();
  queueSavePopoverPosition();
  if (process.env.RATE_LIMIT_TOOL_DEBUG) {
    console.log("Popover visible:", window.isVisible(), window.getBounds());
  }
}

function togglePopover() {
  const window = ensurePopover();

  if (window.isVisible()) {
    queueSavePopoverPosition();
    window.hide();
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
      sandbox: true,
      backgroundThrottling: true,
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
    // Just logged in — bypass the throttle to pick up fresh usage immediately.
    refreshClaudeWebUsage({ force: true }).catch(() => {});
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

async function refreshClaudeWebUsage({ force = false } = {}) {
  if (claudeWebRefreshPromise) {
    return claudeWebRefreshPromise;
  }

  // The scrape spins up a full claude.ai renderer, so throttle it: no matter how often
  // callers ask (the 60s snapshot loop does), actually scrape at most once per
  // claudeWebRefreshMs and otherwise return the cached result.
  if (!force && Date.now() - lastClaudeWebScrapeAt < claudeWebRefreshMs) {
    return claudeWebUsageCache;
  }
  lastClaudeWebScrapeAt = Date.now();

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
    // Don't keep a full claude.ai renderer resident between scrapes — it's the biggest
    // idle memory holder and grows over time. Recreated on the next refresh.
    if (claudeUsageWindow && !claudeUsageWindow.isDestroyed()) {
      claudeUsageWindow.destroy();
      claudeUsageWindow = null;
    }
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
        stale: false,
        error: undefined,
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

function hasClaudeFiveHourWindow(windows = []) {
  return windows.some((window) => /5[-\s]?hour|5h|current\s*session/i.test(window?.label || ""));
}

function shouldRefreshClaudeCliUsage(force = false) {
  if (claudeWebUsageCache.ok && hasClaudeFiveHourWindow(claudeWebUsageCache.data?.windows || [])) {
    return false;
  }

  return force || Date.now() - lastClaudeCliUsageRefreshAt >= claudeCliUsageRefreshMs;
}

async function refreshClaudeCliUsage() {
  if (claudeCliUsageRefreshPromise) {
    return claudeCliUsageRefreshPromise;
  }

  lastClaudeCliUsageRefreshAt = Date.now();
  claudeCliUsageRefreshPromise = refreshAllAccounts({
    onlyAccountTypes: ["claude"],
    skipDiscoveryTypes: ["claude"]
  });

  try {
    return await claudeCliUsageRefreshPromise;
  } finally {
    claudeCliUsageRefreshPromise = null;
  }
}

function mergeAccountRefresh(snapshot, refreshedSnapshot) {
  if (!refreshedSnapshot?.results?.length) {
    return snapshot;
  }

  const refreshedByAccountId = new Map(
    refreshedSnapshot.results.map((result) => [result.accountId, result])
  );

  return {
    ...snapshot,
    config: refreshedSnapshot.config || snapshot.config,
    results: snapshot.results.map((result) => refreshedByAccountId.get(result.accountId) || result)
  };
}

// Flatten the live snapshot's per-account limit windows into the shape
// computeWindowValues wants. One account per
// service is the norm; take the first OK result per service to avoid double rows.
function liveLimitWindows() {
  const results = latestSnapshot?.results || [];
  const seenServices = new Set();
  const limits = [];
  for (const result of results) {
    const service = result?.data?.service;
    if (!result.ok || !service || seenServices.has(service)) continue;
    const windows = result.data.windows || [];
    if (!windows.length) continue;
    seenServices.add(service);
    for (const w of windows) {
      limits.push({
        cli: service,
        id: w.id,
        source: w.source,
        label: w.label,
        durationSeconds: w.durationSeconds,
        usedPercent: w.usedPercent,
        resetAt: w.resetAt
      });
    }
  }
  return limits;
}

function liveRunwayInput() {
  const results = latestSnapshot?.results || [];
  const byService = new Map();

  for (const result of results) {
    const service = result?.data?.service;
    const windows = result?.data?.windows || [];
    if (!result.ok || !service || !windows.length) continue;
    const entry = byService.get(service) || [];
    entry.push({ accountId: result.accountId, windows });
    byService.set(service, entry);
  }

  const limits = [];
  const ambiguousServices = [];
  for (const [service, accounts] of byService) {
    const eligible = accounts.filter((account) => account.windows.some((window) =>
      Number(window.durationSeconds) > 0 || /5-hour|5h|session|week|7-day|7d/i.test(window.label || "")
    ));
    if (eligible.length > 1) {
      ambiguousServices.push(service);
      continue;
    }
    const account = eligible[0] || accounts[0];
    for (const window of account.windows) {
      limits.push({
        cli: service,
        id: window.id,
        source: window.source,
        label: window.label,
        durationSeconds: window.durationSeconds,
        usedPercent: window.usedPercent,
        resetAt: window.resetAt
      });
    }
  }
  return { limits, ambiguousServices };
}

function getRunways() {
  if (!latestSnapshot?.results?.length) {
    return [];
  }
  const { limits, ambiguousServices } = liveRunwayInput();
  return computeRunways({
    homeDir: os.homedir(),
    limits,
    ambiguousServices,
    extraRoots: scanRoots,
    dataDir: appDataDir
  });
}

function startUpdateChecks() {
  globalThis.usageMeterCoreUpdater?.start();
}

// Mirror the user's configured scan folders from config into the module-level cache
// (as absolute paths) so the synchronous history path can use them. Called at startup
// and whenever the config is saved.
async function refreshScanRoots() {
  try {
    const state = await getState();
    const sr = state.config.scanRoots || { claude: [], codex: [] };
    scanRoots = {
      claude: (sr.claude || []).map((p) => expandHome(p)),
      codex: (sr.codex || []).map((p) => expandHome(p))
    };
  } catch {
    scanRoots = { claude: [], codex: [] };
  }
}

// windowValues and diagnostics are range-independent (they scan the recent window and
// the current limits, not the N-day range), so compute them once per recompute and
// share across ranges instead of redoing the scan per range.
function computeSharedHistoryParts() {
  return {
    windowValues: computeWindowValues({ homeDir: os.homedir(), limits: liveLimitWindows(), extraRoots: scanRoots, dataDir: appDataDir }),
    diagnostics: buildDiagnostics({ homeDir: os.homedir(), dataDir: appDataDir, extraRoots: scanRoots }),
    appVersion: app.getVersion(),
    computedAt: new Date().toISOString()
  };
}

function computeHistoryPayload(rangeDays, shared) {
  const s = shared || computeSharedHistoryParts();
  const payload = scanUsageHistory({ homeDir: os.homedir(), dataDir: appDataDir, rangeDays, extraRoots: scanRoots });
  payload.windowValues = s.windowValues;
  payload.diagnostics = s.diagnostics;
  payload.appVersion = s.appVersion;
  payload.computedAt = s.computedAt;
  return payload;
}

function historyWindowOpen() {
  return Boolean(historyWindow && !historyWindow.isDestroyed());
}

// Refresh the cached payload on the limit-refresh cadence — but ONLY while the history
// window is actually open. When it's closed there's nobody to show it to, so we skip
// the expensive scan entirely (the window's caches are also freed on close). This is
// what keeps the app idle-cheap; the ~1.4 GB re-parse no longer runs every ~60s.
function recomputeHistoryCache() {
  if (!historyWindowOpen()) {
    return;
  }
  // Skip when BOTH transcripts AND live limits are unchanged. windowValues derives from
  // the limit %/resetAt, which move independently of transcript writes.
  const limitsSignature = JSON.stringify(
    liveLimitWindows().map((w) => [w.cli, w.label, w.usedPercent, w.resetAt])
  );
  const fingerprint = `${transcriptFingerprint(os.homedir(), scanRoots)}|${limitsSignature}`;
  if (fingerprint === historyFingerprint && historyCache.size) {
    return;
  }
  historyFingerprint = fingerprint;

  const shared = computeSharedHistoryParts();
  for (const rangeDays of historyCache.keys()) {
    try {
      historyCache.set(rangeDays, computeHistoryPayload(rangeDays, shared));
    } catch (error) {
      logRefreshMetric({ event: "history_cache_error", rangeDays, error: error.message });
    }
  }
}

// Drop the cached payloads and the per-file points cache when the history window closes,
// so nothing heavy stays resident while nobody's viewing history.
function releaseHistoryMemory() {
  historyCache.clear();
  historyFingerprint = null;
  clearPointsCache();
}

// Debounce: a single refresh cycle can broadcast more than once (web + background).
// Defer to the next tick so the recompute never blocks the broadcast itself.
function scheduleHistoryRecompute() {
  if (historyRecomputeQueued) {
    return;
  }
  historyRecomputeQueued = true;
  setImmediate(() => {
    historyRecomputeQueued = false;
    recomputeHistoryCache();
  });
}

function getHistoryPayload(rangeDays) {
  if (!historyCache.has(rangeDays)) {
    // First request for this range before the cache warmed — compute once, then it
    // rides the broadcast cadence from here on.
    historyCache.set(rangeDays, computeHistoryPayload(rangeDays));
  }
  return historyCache.get(rangeDays);
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

function preserveStoredClaudeUsage(snapshot) {
  const storedUsageByAccountId = new Map(
    (snapshot?.config?.accounts || [])
      .filter((account) => account.type === "claude" && account.lastUsage)
      .map((account) => [account.id, account.lastUsage])
  );

  return {
    ...snapshot,
    results: (snapshot?.results || []).map((result) => {
      if (result.error !== "Skipped for fast refresh.") {
        return result;
      }

      const data = storedUsageByAccountId.get(result.accountId);
      if (!data) {
        return result;
      }

      return {
        accountId: result.accountId,
        ok: true,
        stale: true,
        error: claudeWebUsageCache.error || "Waiting for Claude usage refresh.",
        data
      };
    })
  };
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
  // Refresh the cached usage-history payload on the same cadence as the limits.
  scheduleHistoryRecompute();

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

async function refreshSnapshot({ forceClaudeCliUsage = false } = {}) {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const refreshStartedAt = nowMs();
    let snapshot;
    const previousSnapshot = latestSnapshot;

    const claudeStartedAt = nowMs();
    const claudeRefresh = refreshClaudeWebUsage();

    const accountRefreshStartedAt = nowMs();
    try {
      snapshot = await refreshAllAccounts({ skipAccountTypes: ["claude"] });
    } catch (error) {
      snapshot = await buildFailureSnapshot(error);
    }
    const accountRefreshMs = nowMs() - accountRefreshStartedAt;

    await claudeRefresh;
    const claudeFetchMs = nowMs() - claudeStartedAt;
    const claudeCliSnapshot = shouldRefreshClaudeCliUsage(forceClaudeCliUsage)
      ? await refreshClaudeCliUsage()
      : null;

    const mergeStartedAt = nowMs();
    snapshot = preserveRecentSuccessfulResults(snapshot, previousSnapshot);
    snapshot = mergeAccountRefresh(snapshot, claudeCliSnapshot);
    snapshot = preserveStoredClaudeUsage(snapshot);
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
    logRefreshMetric({
      event: "claude_web_refresh",
      durationMs: claudeFetchMs,
      status: claudeWebUsageCache.status,
      ok: claudeWebUsageCache.ok,
      error: claudeWebUsageCache.ok ? undefined : claudeWebUsageCache.error
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
  ipcMain.handle("rate-limit:get-runways", () => getRunways());
  ipcMain.handle("rate-limit:save-config", async (event, config) => {
    await saveConfig(config);
    await refreshScanRoots();
    // Configured folders changed — drop the cached history so it rescans next fetch.
    historyCache.clear();
    historyFingerprint = null;
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
  ipcMain.handle("rate-limit:refresh", () => refreshSnapshot({ forceClaudeCliUsage: true }));
  ipcMain.handle("rate-limit:toggle", togglePopover);
  ipcMain.on("rate-limit:set-expanded-view", (event, expanded, rowCount, contentHeight) => {
    setExpandedView(Boolean(expanded), rowCount, contentHeight);
  });
  ipcMain.on("rate-limit:move-top-right", moveToTopRight);
  ipcMain.handle("usage-history:get", (event, options = {}) => {
    const rangeDays = [7, 30, 90].includes(Number(options.rangeDays)) ? Number(options.rangeDays) : 30;
    return getHistoryPayload(rangeDays);
  });
  ipcMain.on("usage-history:open", openHistoryWindow);
  ipcMain.handle("usage-history:pick-folder", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose a session folder to scan",
      properties: ["openDirectory"]
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showPopover();
  });

  app.whenReady().then(async () => {
    app.setName("Usage Meter");

    await enableLaunchAtLoginByDefault();

    if (app.dock) {
      app.dock.hide();
    }

    await loadPopoverPosition();
    await refreshScanRoots();
    registerIpcHandlers();
    createPopover();
    createTray();
    popover.once("ready-to-show", showPopover);
    setTimeout(showPopover, 800);
    startBackgroundRefresh();
    startClaudeWebUsageRefresh();
    refreshSnapshot({ forceClaudeCliUsage: true }).catch(() => {});
    startUpdateChecks();

    const registered = globalShortcut.register(toggleShortcut, togglePopover);
    if (process.env.RATE_LIMIT_TOOL_DEBUG) {
      console.log(`Shortcut ${toggleShortcut} registered:`, registered);
    }
    if (!registered) {
      console.warn(`Could not register global shortcut ${toggleShortcut}.`);
    }
  });

  app.on("activate", () => {
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
  globalShortcut.unregisterAll();
});
