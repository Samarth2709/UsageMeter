const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

function eventTarget(properties = {}) {
  const listeners = new Map();
  return {
    ...properties,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    emit(type, properties = {}) {
      const event = { type, preventDefault() {}, ...properties };
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

test("bottom-left resizing survives unavailable capture and ends with the gesture", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "public", "spatial.js"), "utf8");
  const calls = [];
  const handle = eventTarget({
    dataset: { resizeEdge: "sw" },
    setPointerCapture() {},
    hasPointerCapture: () => false
  });
  const window = eventTarget({ rateLimitAPI: { resizePopover: (...args) => calls.push(args) } });
  const document = eventTarget({ hidden: false });
  const context = {
    stage: { classList: { add() {} }, querySelectorAll: () => [handle] },
    window, document, innerWidth: 254, innerHeight: 233,
    current: [0, 0], target: [0, 0], holding: false, aim() {}
  };
  vm.runInNewContext(source.slice(source.indexOf("if (stage && window.rateLimitAPI?.resizePopover)")), context);
  const start = () => handle.emit("pointerdown", { button: 0, pointerId: 1, screenX: 1270, screenY: 267 });
  const move = (pointerId = 1) => window.emit("pointermove", { pointerId, screenX: 1138, screenY: 410 });

  start();
  move(2);
  assert.equal(calls.length, 0, "unrelated pointers must not resize the window");
  move();
  assert.deepEqual(calls, [[386, 376, "sw"]]);
  window.emit("pointerup", { pointerId: 1 });
  move();
  assert.equal(calls.length, 1);

  for (const ending of ["pointercancel", "blur", "visibilitychange", "lostpointercapture"]) {
    start();
    if (ending === "visibilitychange") {
      document.hidden = true;
      document.emit(ending);
      document.hidden = false;
    } else if (ending === "lostpointercapture") {
      handle.emit(ending, { pointerId: 1 });
    } else {
      window.emit(ending, { pointerId: 1 });
    }
    move();
    assert.equal(calls.length, 1, `${ending} must end resizing`);
  }

  handle.emit("keydown", { key: "ArrowLeft" });
  handle.emit("keydown", { key: "ArrowRight" });
  handle.emit("keydown", { key: "ArrowDown" });
  assert.deepEqual(calls.slice(1), [[262, 233, "sw"], [246, 233, "sw"], [254, 241, "sw"]]);
});
