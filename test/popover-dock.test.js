const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function dockFixture(display = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 957 } }) {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron-main.js"), "utf8");
  let now = 1000, serial = 0, cursor = { x: 500, y: 500 };
  const timers = new Map(), windows = [];
  const context = {
    path, __dirname: "/fixture", process: { env: {} },
    Date: class extends Date { static now() { return now; } },
    screen: { getPrimaryDisplay: () => display, getCursorScreenPoint: () => cursor },
    setTimeout(fn, delay) { timers.set(++serial, { fn, at: now + delay }); return serial; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return 99; },
    BrowserWindow: class {
      constructor(options) {
        this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
        this.handlers = {}; this.messages = []; this.visible = false;
        this.webContents = { send: (...args) => this.messages.push(args) };
        windows.push(this);
      }
      on(name, fn) { this.handlers[name] = fn; }
      loadFile() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
      setBounds(bounds) { this.bounds = bounds; }
      getBounds() { return this.bounds; }
      setIgnoreMouseEvents(ignore) { this.ignoresMouse = ignore; }
      showInactive() { this.visible = true; }
      hide() { this.visible = false; }
      isVisible() { return this.visible; }
      isDestroyed() { return !!this.destroyed; }
      destroy() { this.destroyed = true; this.handlers.closed(); }
    },
    atomicWriteJson: async () => {}, windowStatePath: "/fixture/state"
  };
  vm.runInNewContext(`
    ${source.slice(source.indexOf("const windowWidth"), source.indexOf("const appDataDir"))}
    let currentWindowWidth = 236, currentWindowHeight = 237;
    let popover = null, tray = null, popoverPosition = null, popoverSize = {width:236,height:237};
    let currentRowCount = 2, popoverPositionSaveTimer = null, isQuitting = false;
    ${source.slice(source.indexOf("const popoverDock ="), source.indexOf("let latestSnapshot"))}
    ${source.slice(source.indexOf("function createPopover()"), source.indexOf("async function openClaudeLoginInChrome()"))}
    globalThis.api = { createPopover, showPopover, hidePopover, togglePopover, updatePopoverDock,
      resizePopover, getPopoverBounds, state: popoverDock, quit: () => { isQuitting = true; } };
  `, context);
  context.api.createPopover();
  const tick = (ms = 0) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    context.api.updatePopoverDock();
  };
  return { ...context.api, windows, display, tick,
    move(x, y) { cursor = { x, y }; tick(); },
    latest: () => windows.at(-1) };
}

test("starts hidden; only the top-right screen edge reveals without growing the window", () => {
  const f = dockFixture();
  assert.equal(f.latest().visible, false);
  for (const [x, y] of [[1508, 50], [1511, 300], [1512, 50], [1, 50], [1511, -1]]) {
    f.move(x, y); assert.equal(f.state.open, false);
  }
  f.move(1511, 0);
  assert.equal(f.state.open, true);
  assert.equal(f.latest().visible, true);
  assert.equal(f.latest().ignoresMouse, false);
  assert.equal(f.latest().bounds.width, 236);
  assert.equal(f.latest().bounds.height, 237);
  assert.equal(f.latest().bounds.x + f.latest().bounds.width, f.display.bounds.x + f.display.bounds.width);
  assert.deepEqual(f.latest().messages.at(-1), ["rate-limit:dock-state", true]);
});

test("entry corridor stays open; leaving delays retreat and hides only after the slide", () => {
  const f = dockFixture(); f.move(1511, 50); f.tick(700);
  f.move(1508, 80); f.tick(1000); assert.equal(f.state.open, true);
  f.move(500, 500); f.tick(349); assert.equal(f.state.open, true);
  f.tick(1); assert.equal(f.state.open, false);
  assert.equal(f.latest().visible, true);
  assert.equal(f.latest().ignoresMouse, true);
  f.tick(359); assert.equal(f.latest().visible, true);
  f.tick(1); assert.equal(f.latest().visible, false);
});

test("returning during dismissal or a slide cancels hiding", () => {
  const f = dockFixture(); f.move(1511, 50); f.tick(600);
  f.move(500, 500); f.tick(200); f.move(1400, 100); f.tick(400);
  assert.equal(f.state.open, true);
  f.move(500, 500); f.tick(350); assert.equal(f.state.open, false);
  f.tick(60); f.move(1450, 100); f.tick(400);
  assert.equal(f.latest().visible, true); assert.equal(f.state.open, true);
  assert.equal(f.latest().ignoresMouse, false);
});

test("pointer capture and native menus hold the dock until the interaction ends", () => {
  for (const hold of ["pointer", "menu"]) {
    const f = dockFixture(); f.move(1511, 50); f.tick(600);
    f.state[hold] = true; f.move(500, 500); f.tick(5000);
    assert.equal(f.state.open, true);
    f.state[hold] = false; f.tick(); f.tick(350);
    assert.equal(f.state.open, false);
  }
});

test("keyboard navigation stays open until cursor movement or blur", () => {
  const f = dockFixture(); f.showPopover(); f.tick(2500);
  f.state.keyboard = true; f.tick(10000); assert.equal(f.state.open, true);
  f.move(501, 500); f.tick(350); assert.equal(f.state.open, false);
  f.showPopover(); f.state.keyboard = true;
  f.latest().handlers.blur(); assert.equal(f.state.keyboard, false);
});

test("manual reveal has a usable grace period and toggling reverses pending hide", () => {
  const f = dockFixture(); f.togglePopover(); f.tick(1999);
  assert.equal(f.state.open, true);
  f.togglePopover(); assert.equal(f.state.open, false);
  f.tick(100); f.togglePopover(); f.tick(500);
  assert.equal(f.latest().visible, true);
});

test("manual dismissal at the edge stays tucked until the cursor leaves and returns", () => {
  const f = dockFixture(); f.move(1511, 50); f.togglePopover(); f.tick(1000);
  assert.equal(f.state.open, false); assert.equal(f.latest().visible, false);
  f.move(1450, 50); f.move(1511, 50); assert.equal(f.state.open, true);
});

test("secondary display origin and fixed-corner resizing are respected", () => {
  const f = dockFixture({ bounds: {x:-1600,y:-100,width:1600,height:1000}, workArea: {x:-1600,y:-75,width:1600,height:975} });
  f.move(-1, -100); assert.equal(f.state.open, true);
  const before = f.latest().bounds;
  f.resizePopover(312, 280, "sw"); const after = f.latest().bounds;
  assert.equal(after.x + after.width, before.x + before.width);
  assert.equal(after.y, before.y);
  f.hidePopover(); f.tick(400); f.move(-500, 500); f.move(-1, 30);
  assert.equal(f.state.open, true);
  assert.equal(f.latest().bounds.width, 312); assert.equal(f.latest().bounds.height, 280);
});

test("smaller work areas constrain the visible bounds without losing the selected size", () => {
  const f = dockFixture(); f.resizePopover(520, 620, "sw");
  f.display.workArea.height = 500; f.display.workArea.width = 480; f.display.bounds.width = 480;
  const small = f.getPopoverBounds();
  assert.equal(small.width, 468); assert.equal(small.height, 476);
  assert.equal(small.x + small.width, 480); assert.equal(small.y + small.height, 513);
  f.display.workArea.height = 957; f.display.workArea.width = 1512; f.display.bounds.width = 1512;
  assert.equal(f.getPopoverBounds().height, 620);
  assert.equal(f.getPopoverBounds().width, 520);
});

test("screen-edge reveal recreates a destroyed window, and stops on quit", () => {
  const f = dockFixture(); f.move(1511, 50); f.latest().destroy();
  assert.equal(f.state.open, false); f.tick();
  assert.equal(f.windows.length, 2); assert.equal(f.latest().visible, true);
  f.hidePopover(); f.quit(); f.tick(1000);
  assert.equal(f.latest().visible, false); assert.equal(f.state.open, false);
});
