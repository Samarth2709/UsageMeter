const path = require("path");
const http = require("http");
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
  processAutoStartSnapshot,
  openLoginForAccountById
} = require("./server");

const toggleShortcut = "Control+Option+L";
const windowWidth = 344;
const windowHeight = 170;
const backgroundRefreshMs = 60000;
const claudeUsageApiPort = Number(process.env.CLAUDE_USAGE_API_PORT || 4555);
const claudeUsageUrl = process.env.CLAUDE_USAGE_URL || "https://claude.ai/settings/usage";
const claudeWebRefreshMs = 30000;
const autoStartEnabled = process.env.RATE_LIMIT_TOOL_AUTOSTART_ENABLED === "1";

let tray = null;
let popover = null;
let lastPopoverBounds = null;
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
let claudeWebUsageCache = {
  ok: false,
  status: "starting",
  error: "Claude web usage has not refreshed yet.",
  fetchedAt: null
};

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
  popover = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
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

  popover.loadFile(path.join(__dirname, "public", "index.html"));

  popover.on("moved", () => {
    lastPopoverBounds = popover.getBounds();
  });

  popover.on("blur", () => {
    if (process.env.RATE_LIMIT_TOOL_KEEP_OPEN) {
      return;
    }

    if (!isQuitting && !popover.webContents.isDevToolsOpened()) {
      lastPopoverBounds = popover.getBounds();
      popover.hide();
    }
  });
}

function positionPopover() {
  if (lastPopoverBounds) {
    popover.setBounds(lastPopoverBounds);
    return;
  }

  const trayBounds = tray.getBounds();
  const display = trayBounds.width > 0 && trayBounds.height > 0
    ? screen.getDisplayNearestPoint({
        x: Math.round(trayBounds.x),
        y: Math.round(trayBounds.y)
      })
    : screen.getPrimaryDisplay();
  const x = Math.round(display.workArea.x + display.workArea.width - windowWidth - 12);
  const y = Math.round(display.workArea.y + 12);

  popover.setBounds({ x, y, width: windowWidth, height: windowHeight });
}

function showPopover() {
  positionPopover();
  popover.show();
  popover.focus();
  if (process.env.RATE_LIMIT_TOOL_DEBUG) {
    console.log("Popover visible:", popover.isVisible(), popover.getBounds());
  }
}

function togglePopover() {
  if (!popover) {
    return;
  }

  if (popover.isVisible()) {
    lastPopoverBounds = popover.getBounds();
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
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
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

async function refreshClaudeWebUsage() {
  if (claudeWebRefreshPromise) {
    return claudeWebRefreshPromise;
  }

  claudeWebRefreshPromise = (async () => {
    try {
      claudeWebUsageCache = parseClaudeWebUsagePage(await readClaudeUsagePage());
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

  return {
    ...snapshot,
    results: snapshot.results.map((result) => {
      if (!claudeAccountIds.has(result.accountId)) {
        return result;
      }

      return {
        ...result,
        ok: true,
        data: {
          ...(result.data || {}),
          ...claudeWebUsageCache.data,
          source: "claude_web_usage"
        }
      };
    })
  };
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(body, null, 2));
}

function startClaudeUsageApiServer() {
  if (claudeUsageApiServer) {
    return;
  }

  claudeUsageApiServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${claudeUsageApiPort}`);

    if (request.method === "OPTIONS") {
      sendJson(response, 200, { ok: true });
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

async function refreshSnapshot() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    let snapshot;

    try {
      snapshot = await refreshAllAccounts();
    } catch (error) {
      snapshot = await buildFailureSnapshot(error);
    }

    latestSnapshot = snapshot;
    latestSnapshot = await mergeClaudeWebUsage(latestSnapshot);
    broadcastSnapshot(latestSnapshot);
    queueAutoStart(latestSnapshot);
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
    return openLoginForAccountById(accountId);
  });
  ipcMain.handle("rate-limit:refresh", () => refreshSnapshot());
  ipcMain.handle("rate-limit:toggle", togglePopover);
}

app.whenReady().then(() => {
  app.setName("Usage Meter");

  if (app.dock) {
    app.dock.hide();
  }

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

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  clearInterval(backgroundRefreshTimer);
  clearInterval(claudeWebRefreshTimer);
  if (claudeUsageApiServer) {
    claudeUsageApiServer.close();
  }
  globalShortcut.unregisterAll();
});
