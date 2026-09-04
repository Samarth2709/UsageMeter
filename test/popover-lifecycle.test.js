const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

class FakeBrowserWindow {
  constructor(options) {
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.destroyed = false;
    this.visible = false;
    this.visibleOnAllWorkspacesCalls = [];
    this.handlers = new Map();
    this._webContents = { id: 1, send() {} };
  }

  get webContents() {
    if (this.destroyed) throw new Error("Object has been destroyed");
    return this._webContents;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  setVisibleOnAllWorkspaces(visible, options) {
    this.visibleOnAllWorkspacesCalls.push({ visible, options });
  }
  loadFile() {}
  setBounds(bounds) { this.bounds = bounds; }
  getBounds() { return this.bounds; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }

  destroy() {
    this.destroyed = true;
    this.handlers.get("closed")?.();
  }
}

test("shortcut recreates a popover destroyed by macOS", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");
  const start = source.indexOf("function createPopover()");
  const end = source.indexOf("function createTray()");
  assert.ok(start >= 0 && end > start, "popover lifecycle functions must be present");

  const windows = [];
  class TrackingBrowserWindow extends FakeBrowserWindow {
    constructor(options) {
      super(options);
      windows.push(this);
    }
  }

  const context = {
    BrowserWindow: TrackingBrowserWindow,
    path: { join: (...parts) => parts.join("/") },
    process: { env: {} },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      getCursorScreenPoint: () => context.cursorPoint
    },
    __dirname: "/app",
    clearTimeout: () => {},
    setTimeout: () => 1
  };
  const lifecycleSource = source.slice(start, end);
  vm.runInNewContext(
    `
      let popover = null;
      let tray = null;
      let currentWindowHeight = 220;
      let currentRowCount = 3;
      let popoverPosition = null;
      let popoverPositionSaveTimer = null;
      const popoverDock = { open: false, outsideSince: null };
      let isQuitting = false;
      const windowWidth = 344;
      let currentWindowWidth = windowWidth;
      let popoverSize = null;
      const compactWindowHeight = 170;
      const expandedWindowHeight = 220;
      const minWindowHeight = 70;
      const maxWindowHeight = 620;
      ${lifecycleSource}
      globalThis.popoverLifecycle = {
        togglePopover,
        getPopover: () => popover,
        isCursorNearPopoverBottom
      };
    `,
    context
  );

  context.popoverLifecycle.togglePopover();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].isVisible(), true);
  assert.equal(windows[0].visibleOnAllWorkspacesCalls.length, 2);
  for (const call of windows[0].visibleOnAllWorkspacesCalls) {
    assert.equal(call.visible, true);
    assert.equal(call.options.visibleOnFullScreen, true);
    assert.equal(call.options.skipTransformProcessType, true);
  }

  const bounds = windows[0].getBounds();
  context.cursorPoint = { x: bounds.x + 100, y: bounds.y + bounds.height - 10 };
  assert.equal(context.popoverLifecycle.isCursorNearPopoverBottom(30), true);

  context.cursorPoint = { x: bounds.x + 100, y: bounds.y + 40 };
  assert.equal(context.popoverLifecycle.isCursorNearPopoverBottom(30), false);

  context.cursorPoint = { x: bounds.x + bounds.width + 1, y: bounds.y + bounds.height - 10 };
  assert.equal(context.popoverLifecycle.isCursorNearPopoverBottom(30), false);

  windows[0].destroy();
  assert.equal(context.popoverLifecycle.getPopover(), null);

  context.popoverLifecycle.togglePopover();
  assert.equal(windows.length, 2);
  assert.equal(windows[1].isVisible(), true);
});
