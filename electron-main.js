const path = require("path");
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
  openLoginForAccountById
} = require("./server");

const toggleShortcut = "Control+Option+L";
const windowWidth = 344;
const windowHeight = 170;
const backgroundRefreshMs = 60000;

let tray = null;
let popover = null;
let isQuitting = false;
let latestSnapshot = null;
let refreshPromise = null;
let backgroundRefreshTimer = null;

function createTrayIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.svg"));
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
    title: "Rate Limit Tool",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  popover.loadFile(path.join(__dirname, "public", "index.html"));

  popover.on("blur", () => {
    if (process.env.RATE_LIMIT_TOOL_KEEP_OPEN) {
      return;
    }

    if (!isQuitting && !popover.webContents.isDevToolsOpened()) {
      popover.hide();
    }
  });
}

function positionPopover() {
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
    popover.hide();
    return;
  }

  showPopover();
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Rate Limit Tool");
  tray.on("click", togglePopover);
  tray.on("right-click", () => {
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: "Show / Hide", accelerator: toggleShortcut, click: togglePopover },
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

function broadcastSnapshot(snapshot) {
  if (!popover || popover.isDestroyed()) {
    return;
  }

  popover.webContents.send("rate-limit:snapshot", snapshot);
}

async function refreshSnapshot() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const snapshot = await refreshAllAccounts();
    latestSnapshot = snapshot;
    broadcastSnapshot(snapshot);
    return snapshot;
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
  app.setName("Rate Limit Tool");

  if (app.dock) {
    app.dock.hide();
  }

  registerIpcHandlers();
  createPopover();
  createTray();
  popover.once("ready-to-show", showPopover);
  setTimeout(showPopover, 800);
  startBackgroundRefresh();

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
  globalShortcut.unregisterAll();
});
