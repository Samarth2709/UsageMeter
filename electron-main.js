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
  nativeTheme,
  screen,
  dialog,
  utilityProcess
} = require("electron");

const {
  getState,
  saveConfig,
  expandHome,
  refreshAllAccounts,
  processAutoStartSnapshot,
  onClaudeLoginCompleted,
  openLoginForAccountById,
  logoutAccountById,
  removeAccountById
} = require("./server");
const { runIndexWorkerProcess } = require("./usage-history/index-worker-client");
const { atomicWriteJson, atomicWriteJsonSync } = require("./atomic-file");

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
const autoStartEnabled = process.env.RATE_LIMIT_TOOL_AUTOSTART_ENABLED === "1";
const gotSingleInstanceLock = globalThis.__usageMeterSingleInstanceLockAcquired
  ?? app.requestSingleInstanceLock();

let tray = null;
let popover = null;
let historyWindow = null;
let historyDialogOpen = false;
let currentWindowHeight = expandedWindowHeight;
let currentRowCount = 3;
let popoverPosition = null;
let popoverPositionSaveTimer = null;
let isQuitting = false;
let latestSnapshot = null;
let refreshPromise = null;
let accountMutationGeneration = 0;
let backgroundRefreshTimer = null;
let autoStartPromise = null;
let stopClaudeLoginCompletionRefresh = null;
// Pre-computed usage-history payloads (rangeDays -> payload), kept warm so the
// "View usage history" window opens instantly instead of scanning transcripts on click.
let historyCache = new Map();
let historyRecomputePromise = null;
let historyRecomputeAgain = false;
let historyCacheGeneration = 0;
let indexWorkerQueue = Promise.resolve();
const activeIndexWorkers = new Set();
// User-configured extra transcript folders (absolute paths), mirrored from config so
// the synchronous history path can read them without an async config load each time.
let scanRoots = { claude: [], codex: [] };
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
    await atomicWriteJson(statePath, { enabledAt: new Date().toISOString() });
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
    // The renderer paints a rounded material card; the window itself is
    // transparent so the card edge, not the window edge, is what shows.
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    vibrancy: "popover",
    // Keep the material lit: the popover is shown inactive and never focused.
    visualEffectState: "active",
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

  const popoverWebContents = window.webContents;
  popover = window;
  globalThis.__usageMeterRegisterCoreWebContents?.(popoverWebContents);
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });
  window.loadFile(path.join(__dirname, "public", "index.html"));

  window.on("move", queueSavePopoverPosition);
  window.on("moved", queueSavePopoverPosition);
  window.on("closed", () => {
    if (popover === window) {
      popover = null;
    }
    globalThis.__usageMeterUnregisterCoreWebContents?.(popoverWebContents);
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
    await atomicWriteJson(windowStatePath, {
      x: Math.round(position.x),
      y: Math.round(position.y),
      savedAt: new Date().toISOString()
    });
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
  popover.setBounds(clampPopoverBounds({
    x: bounds.x,
    y: bounds.y,
    width: windowWidth,
    height: currentWindowHeight
  }));
  queueSavePopoverPosition();
}

// The popover has no title bar and no free chrome to grab, so the renderer
// drags it: it sends the cursor delta and the window follows, clamped to the
// display the way every other move is.
function movePopoverBy(dx, dy) {
  if (!popover || popover.isDestroyed()) {
    return;
  }

  const deltaX = Number(dx);
  const deltaY = Number(dy);
  const stepX = Number.isFinite(deltaX) ? Math.round(deltaX) : 0;
  const stepY = Number.isFinite(deltaY) ? Math.round(deltaY) : 0;
  if (!stepX && !stepY) {
    return;
  }

  const bounds = popover.getBounds();
  popover.setBounds(clampPopoverBounds({ x: bounds.x + stepX, y: bounds.y + stepY }));
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
    minWidth: 720,
    minHeight: 480,
    title: "Usage History",
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#f5f5f7",
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

    if (!isQuitting && !historyDialogOpen && !historyWindow.webContents.isDevToolsOpened()) {
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
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });
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

async function openClaudeLoginInChrome() {
  const state = await getState();
  const account = state.config.accounts.find((entry) => entry.type === "claude");

  if (!account) {
    throw new Error("Claude account not found.");
  }

  return openLoginForAccountById(account.id);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Usage Meter");
  tray.on("click", togglePopover);
  tray.on("right-click", () => {
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: "Show / Hide", accelerator: toggleShortcut, click: togglePopover },
        {
          label: "Sign in to Claude with Chrome",
          click: () => {
            openClaudeLoginInChrome().catch((error) => {
              dialog.showErrorBox("Could not open Claude sign-in", error.message);
            });
          }
        },
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

// Flatten the live snapshot's per-account limit windows into the shape
// computeWindowValues wants. One account per
// service is the norm; take the first OK result per service to avoid double rows.
function liveLimitWindows() {
  const configuredCounts = new Map();
  for (const account of latestSnapshot?.config?.accounts || []) {
    configuredCounts.set(account.type, (configuredCounts.get(account.type) || 0) + 1);
  }
  const results = (latestSnapshot?.results || []).filter((result) => result.ok && result.stale !== true);
  const byService = new Map();
  for (const result of results) {
    const service = result?.data?.service;
    if (!service || !(result.data.windows || []).length) continue;
    const accounts = byService.get(service) || [];
    accounts.push(result);
    byService.set(service, accounts);
  }
  const limits = [];
  for (const [service, accounts] of byService) {
    if (accounts.length !== 1 || configuredCounts.get(service) !== 1) continue;
    const result = accounts[0];
    const windows = result.data.windows || [];
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

function startUpdateChecks() {
  globalThis.usageMeterCoreUpdater?.start();
}

// Mirror the user's configured scan folders into the small request passed to the
// short-lived index worker. Called at startup and whenever the config is saved.
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

function runIndexWorker(request) {
  return runIndexWorkerProcess({
    fork: (...args) => utilityProcess.fork(...args),
    workerPath: path.join(__dirname, "usage-history", "index-worker.js"),
    cwd: __dirname,
    request,
    activeWorkers: activeIndexWorkers
  });
}

function queueIndexWorker(request) {
  if (isQuitting) {
    return Promise.reject(new Error("Usage Meter is quitting."));
  }
  const queued = indexWorkerQueue
    .catch(() => {})
    .then(() => runIndexWorker(request));
  indexWorkerQueue = queued.catch(() => {});
  return queued;
}

function baseIndexRequest(nowMs) {
  return {
    homeDir: os.homedir(),
    dataDir: appDataDir,
    nowMs,
    extraRoots: scanRoots
  };
}

async function computeHistoryPayload(rangeDays, { forceRebuild = false } = {}) {
  const result = await queueIndexWorker({
    ...baseIndexRequest(Date.now()),
    operation: "history",
    rangeDays,
    limits: liveLimitWindows(),
    appVersion: app.getVersion(),
    forceRebuild
  });
  return result.payload;
}

async function computeHistoryPayloads(rangeDays) {
  const result = await queueIndexWorker({
    ...baseIndexRequest(Date.now()),
    operation: "history",
    rangeDays,
    limits: liveLimitWindows(),
    appVersion: app.getVersion()
  });
  return result.payloads;
}

function historyWindowOpen() {
  return Boolean(historyWindow && !historyWindow.isDestroyed());
}

// Refresh History only while its window is open. Parsing and index loading happen in
// the utility process; the main process retains only the compact renderer payload.
async function recomputeHistoryCache() {
  if (!historyWindowOpen()) {
    return;
  }
  const rangeDays = Array.from(historyCache.keys());
  if (!rangeDays.length) return;
  const generation = historyCacheGeneration;
  try {
    const payloads = await computeHistoryPayloads(rangeDays);
    if (!historyWindowOpen() || generation !== historyCacheGeneration) return;
    for (const days of rangeDays) historyCache.set(days, payloads[days]);
    historyWindow.webContents.send("usage-history:updated", payloads);
  } catch (error) {
    logRefreshMetric({ event: "history_cache_error", error: error.message });
  }
}

// Drop renderer payloads when the History window closes.
function releaseHistoryMemory() {
  historyCacheGeneration += 1;
  historyRecomputeAgain = false;
  historyCache.clear();
}

// Debounce: a single refresh cycle can broadcast more than once (web + background).
// Defer to the next tick so the recompute never blocks the broadcast itself.
function scheduleHistoryRecompute() {
  if (!historyWindowOpen()) {
    return;
  }
  if (historyRecomputePromise) {
    historyRecomputeAgain = true;
    return;
  }
  setImmediate(() => {
    if (!historyWindowOpen() || historyRecomputePromise) return;
    historyRecomputePromise = recomputeHistoryCache()
      .catch((error) => {
        logRefreshMetric({ event: "history_cache_error", error: error.message });
      })
      .finally(() => {
        historyRecomputePromise = null;
        if (historyRecomputeAgain && historyWindowOpen()) {
          historyRecomputeAgain = false;
          scheduleHistoryRecompute();
        }
      });
  });
}

async function getHistoryPayload(rangeDays) {
  if (!historyCache.has(rangeDays)) {
    const generation = historyCacheGeneration;
    const payload = await computeHistoryPayload(rangeDays);
    if (historyWindowOpen() && generation === historyCacheGeneration) {
      historyCache.set(rangeDays, payload);
    }
    return payload;
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
        error: result.error,
        staleReason: result.error,
        data: {
          ...previous.data,
          stale: true,
          staleReason: result.error
        }
      };
    })
  };
}

function broadcastSnapshot(snapshot, { refreshHistory = true } = {}) {
  // Refresh the cached usage-history payload on the same cadence as the limits.
  if (refreshHistory) scheduleHistoryRecompute();

  if (!popover || popover.isDestroyed()) {
    return;
  }

  popover.webContents.send("rate-limit:snapshot", snapshot);
}

function reconcileSnapshotWithConfig(snapshot, config) {
  const accounts = config?.accounts || [];
  const accountIds = new Set(accounts.map((account) => account.id));
  const loggedOutIds = new Set(
    accounts.filter((account) => account.loggedOut).map((account) => account.id)
  );
  return {
    ...snapshot,
    config,
    results: (snapshot?.results || [])
      .filter((result) => accountIds.has(result.accountId))
      .map((result) => loggedOutIds.has(result.accountId) ? {
        accountId: result.accountId,
        ok: false,
        error: "Account is logged out. Run login first."
      } : result)
  };
}

function markAccountLoggedOut(snapshot, accountId, config) {
  const reconciled = reconcileSnapshotWithConfig(
    snapshot || { refreshedAt: new Date().toISOString(), results: [] },
    config
  );
  const result = {
    accountId,
    ok: false,
    error: "Account is logged out. Run login first."
  };
  const existingIndex = reconciled.results.findIndex((entry) => entry.accountId === accountId);

  if (existingIndex < 0) {
    reconciled.results.push(result);
  } else {
    reconciled.results[existingIndex] = result;
  }

  return reconciled;
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

async function refreshSnapshot({ forceClaudeUsage = false } = {}) {
  if (refreshPromise) {
    if (!forceClaudeUsage) return refreshPromise;
    return refreshPromise.then(() => refreshSnapshot({ forceClaudeUsage: true }));
  }

  refreshPromise = (async () => {
    const refreshAccountGeneration = accountMutationGeneration;
    const refreshStartedAt = nowMs();
    let snapshot;
    const previousSnapshot = latestSnapshot;

    const accountRefreshStartedAt = nowMs();
    try {
      snapshot = await refreshAllAccounts();
    } catch (error) {
      snapshot = await buildFailureSnapshot(error);
    }
    const accountRefreshMs = nowMs() - accountRefreshStartedAt;

    const mergeStartedAt = nowMs();
    snapshot = preserveRecentSuccessfulResults(snapshot, previousSnapshot);
    let nextSnapshot = snapshot;
    if (refreshAccountGeneration !== accountMutationGeneration) {
      const currentState = await getState();
      nextSnapshot = reconcileSnapshotWithConfig(nextSnapshot, currentState.config);
    }
    latestSnapshot = nextSnapshot;
    const mergeMs = nowMs() - mergeStartedAt;

    broadcastSnapshot(latestSnapshot, { refreshHistory: false });
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

function startClaudeLoginCompletionRefresh() {
  if (stopClaudeLoginCompletionRefresh) return;
  stopClaudeLoginCompletionRefresh = onClaudeLoginCompleted(() => {
    refreshSnapshot({ forceClaudeUsage: true }).catch((error) => {
      console.warn(`Could not refresh after Claude sign-in: ${error.message}`);
    });
  });
}

function showAccountContextMenu() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (action = null) => {
      if (settled) return;
      settled = true;
      resolve(action);
    };
    const menu = Menu.buildFromTemplate([
      { label: "Log Out", click: () => finish("logout") },
      { label: "Log Out & Remove Login", click: () => finish("remove-login") },
      { type: "separator" },
      { label: "Delete Row", click: () => finish("delete-row") }
    ]);

    menu.popup({
      window: popover && !popover.isDestroyed() ? popover : undefined,
      callback: () => finish()
    });
  });
}

function registerIpcHandlers() {
  ipcMain.handle("rate-limit:get-state", () => getState());
  ipcMain.handle("rate-limit:get-snapshot", async () => latestSnapshot);
  ipcMain.handle("rate-limit:save-config", async (event, config) => {
    await saveConfig(config);
    await refreshScanRoots();
    // Configured folders changed — drop the cached history so it rescans next fetch.
    releaseHistoryMemory();
    return getState();
  });
  ipcMain.handle("rate-limit:open-login", async (event, accountId) => {
    return openLoginForAccountById(accountId);
  });
  ipcMain.handle("rate-limit:show-account-menu", async (event, accountId) => {
    const currentState = await getState();
    if (!currentState.config.accounts.some((account) => account.id === accountId)) {
      throw new Error("Account not found.");
    }
    return showAccountContextMenu();
  });
  ipcMain.handle("rate-limit:logout-account", async (event, accountId, removeLogin = false) => {
    const loggedOut = await logoutAccountById(accountId, { removeLogin: Boolean(removeLogin) });
    accountMutationGeneration += 1;
    latestSnapshot = markAccountLoggedOut(latestSnapshot, accountId, loggedOut.config);
    broadcastSnapshot(latestSnapshot, { refreshHistory: false });
    return loggedOut;
  });
  ipcMain.handle("rate-limit:remove-account", async (event, accountId) => {
    const removed = await removeAccountById(accountId);
    accountMutationGeneration += 1;
    latestSnapshot = reconcileSnapshotWithConfig(
      latestSnapshot || { refreshedAt: new Date().toISOString(), results: [] },
      removed.config
    );
    broadcastSnapshot(latestSnapshot, { refreshHistory: false });
    return removed;
  });
  ipcMain.handle("rate-limit:refresh", () => refreshSnapshot({ forceClaudeUsage: true }));
  ipcMain.handle("rate-limit:toggle", togglePopover);
  ipcMain.on("rate-limit:move-popover-by", (event, dx, dy) => {
    movePopoverBy(dx, dy);
  });

  ipcMain.on("rate-limit:set-expanded-view", (event, expanded, rowCount, contentHeight) => {
    setExpandedView(Boolean(expanded), rowCount, contentHeight);
  });
  ipcMain.on("rate-limit:move-top-right", moveToTopRight);
  ipcMain.handle("usage-history:get", async (event, options = {}) => {
    const rangeDays = [7, 30, 90].includes(Number(options.rangeDays)) ? Number(options.rangeDays) : 30;
    return getHistoryPayload(rangeDays);
  });
  ipcMain.handle("usage-history:repair", async (event, options = {}) => {
    const rangeDays = [7, 30, 90].includes(Number(options.rangeDays)) ? Number(options.rangeDays) : 30;
    releaseHistoryMemory();
    const generation = historyCacheGeneration;
    const payload = await computeHistoryPayload(rangeDays, { forceRebuild: true });
    if (historyWindowOpen() && generation === historyCacheGeneration) {
      historyCache.set(rangeDays, payload);
    }
    return payload;
  });
  ipcMain.on("usage-history:open", openHistoryWindow);
  ipcMain.handle("usage-history:pick-folder", async () => {
    historyDialogOpen = true;
    try {
      const result = await dialog.showOpenDialog(historyWindow || undefined, {
        title: "Choose a session folder to scan",
        properties: ["openDirectory"]
      });
      return result.canceled ? null : result.filePaths[0] || null;
    } finally {
      historyDialogOpen = false;
    }
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
    startClaudeLoginCompletionRefresh();
    registerIpcHandlers();
    createPopover();
    createTray();
    popover.once("ready-to-show", showPopover);
    setTimeout(showPopover, 800);
    startBackgroundRefresh();
    refreshSnapshot({ forceClaudeUsage: true }).catch(() => {});
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
  stopClaudeLoginCompletionRefresh?.();
  stopClaudeLoginCompletionRefresh = null;
  clearTimeout(popoverPositionSaveTimer);
  if (popoverPosition) {
    try {
      atomicWriteJsonSync(windowStatePath, {
        x: Math.round(popoverPosition.x),
        y: Math.round(popoverPosition.y),
        savedAt: new Date().toISOString()
      });
    } catch (error) {
      console.warn(`Could not save final window position: ${error.message}`);
    }
  }
});

app.on("window-all-closed", (event) => {
  if (!isQuitting) event.preventDefault();
});

app.on("will-quit", () => {
  clearInterval(backgroundRefreshTimer);
  clearTimeout(popoverPositionSaveTimer);
  for (const child of activeIndexWorkers) child.kill();
  globalShortcut.unregisterAll();
});
