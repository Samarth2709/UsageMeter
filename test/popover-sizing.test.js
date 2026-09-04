const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

async function lifecycle(saved = {}) {
  const source = await fs.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");
  const area = { x: 0, y: 25, width: 1000, height: 750 };
  const windows = [];
  const writes = [];
  const context = {
    JSON,
    BrowserWindow: class {
      constructor(options) { this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; this.webContents = { send() {} }; windows.push(this); }
      setBounds(bounds) { this.bounds = bounds; }
      getBounds() { return this.bounds; }
      setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
      setVisibleOnAllWorkspaces() {}
      loadFile() {}
      on() {}
      isDestroyed() { return false; }
      isVisible() { return this.visible; }
      showInactive() { this.visible = true; }
      hide() { this.visible = false; }
    },
    screen: { getPrimaryDisplay: () => ({ workArea: area }), getDisplayMatching: () => ({ workArea: area }) },
    path, __dirname: "/fixture", process: { env: {} },
    fs: { readFile: async () => JSON.stringify(saved) },
    atomicWriteJson: async (_, state) => writes.push(JSON.parse(JSON.stringify(state))),
    clearTimeout() {}, setTimeout: () => 1
  };
  vm.runInNewContext(`
    ${source.slice(source.indexOf("const windowWidth"), source.indexOf("const appDataDir"))}
    let currentWindowWidth = windowWidth, currentWindowHeight = expandedWindowHeight;
    let popoverSize = null, popoverPosition = null, popover = null, tray = null;
    let currentRowCount = 2, popoverPositionSaveTimer = null;
    const popoverDock = { open: false, outsideSince: null };
    const windowStatePath = "/fixture/window-state.json";
    ${source.slice(source.indexOf("function createPopover()"), source.indexOf("function createTray()"))}
    globalThis.api = { loadPopoverPosition, createPopover, resizePopover, setExpandedView,
      togglePopover,
      bounds: () => JSON.parse(JSON.stringify(popover.getBounds())),
      save: () => savePopoverPosition(popoverPosition) };
  `, context);
  await context.api.loadPopoverPosition();
  context.api.createPopover();
  return { api: context.api, windows, writes, area };
}

test("legacy position restores with compact auto-fit and no native background", async () => {
  const { api, windows, writes } = await lifecycle({ x: 100, y: 80 });
  api.setExpandedView(true, 2, 236);
  assert.equal(api.bounds().width, 276);
  assert.equal(api.bounds().height, 236);
  assert.equal(windows[0].options.transparent, true);
  assert.equal(windows[0].options.frame, false);
  assert.equal(windows[0].options.hasShadow, false);
  assert.equal(windows[0].options.paintWhenInitiallyHidden, false);
  assert.equal(windows[0].options.vibrancy, undefined);
  await api.save();
  assert.equal(writes[0].width, undefined, "auto-fit must not become a saved manual size");
});

test("cursor-selected size survives content changes, hide/show, recreation and state reload", async () => {
  const { api, writes } = await lifecycle({ x: 100, y: 80 });
  api.resizePopover(250, 180, "se");
  const chosen = api.bounds();
  api.setExpandedView(true, 9, 600);
  api.togglePopover(); api.togglePopover(); api.togglePopover();
  assert.deepEqual(api.bounds(), chosen);
  await api.save();
  assert.equal(writes[0].width, 250);
  assert.equal(writes[0].height, 180);
  const restored = await lifecycle(writes[0]);
  restored.api.setExpandedView(true, 2, 236);
  assert.deepEqual(restored.api.bounds(), chosen);
  restored.api.createPopover();
  assert.deepEqual(restored.api.bounds(), chosen);
});

test("all resize handles retain the top-right attachment and keep dimensions bounded", async () => {
  for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const { api } = await lifecycle({ x: 200, y: 150, width: 300, height: 260 });
    const before = api.bounds();
    api.resizePopover(edge.match(/[ew]/) ? 280 : 300, edge.match(/[ns]/) ? 240 : 260, edge);
    const after = api.bounds();
    assert.equal(after.x + after.width, before.x + before.width);
    assert.equal(after.y, before.y);
  }
  const { api, area } = await lifecycle({ x: 0, y: 25 });
  api.resizePopover(-10, 0, "se");
  assert.equal(api.bounds().width, 236);
  assert.equal(api.bounds().height, 160);
  api.resizePopover(100000, 100000, "se");
  assert.equal(api.bounds().width, 520);
  assert.equal(api.bounds().height, 620);
  api.resizePopover(10000, 10000, "se");
  const b = api.bounds();
  assert.ok(b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height);
  assert.equal(b.x + b.width, area.x + area.width);
  assert.equal(b.y, area.y + 12);
});

test("malformed sizes cannot corrupt window bounds or disable auto-fit", async () => {
  const { api } = await lifecycle({ x: 100, y: 80, width: "300", height: 200 });
  const before = api.bounds();
  for (const args of [[NaN, 100, "se"], [100, Infinity, "se"], [100, 100, "invalid"], ["100", 100, "se"]]) api.resizePopover(...args);
  assert.deepEqual(api.bounds(), before);
  api.setExpandedView(true, 2, 236);
  assert.equal(api.bounds().height, 236);
  const { api: bounded } = await lifecycle({ x: 0, y: 25, width: -1, height: 9000 });
  assert.equal(bounded.bounds().width, 236);
  assert.equal(bounded.bounds().height, 620);
});
