const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

async function loadLiquidRuntime() {
  const source = await fs.readFile(path.join(__dirname, "..", "public", "liquid.js"), "utf8");
  const frames = new Map();
  let nextFrame = 1;
  const context = {
    document: {
      hidden: false,
      addEventListener() {}
    },
    window: { devicePixelRatio: 1 },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
    ResizeObserver: class {},
    MutationObserver: class {}
  };

  vm.runInNewContext(
    `${source.replaceAll("export function", "function")}\n` +
      "this.liquidTest = { Liquid, live, start, frame, getRaf: () => raf };",
    context
  );

  return { api: context.liquidTest, frames };
}

test("cached liquid snaps to its target instead of springing", async () => {
  const { api } = await loadLiquidRuntime();
  const liquid = Object.create(api.Liquid.prototype);
  liquid.still = true;
  liquid.chambers = [
    { target: 120, w: 40, v: 15 },
    { target: 90, w: 20, v: -5 }
  ];
  liquid.energy = 1.2;

  liquid.step(1 / 60);

  assert.deepEqual(liquid.chambers, [
    { target: 120, w: 120, v: 0 },
    { target: 90, w: 90, v: 0 }
  ]);
  assert.equal(liquid.energy, 0);
  assert.equal(liquid.needsAnimation(), false);
});

test("the shared frame loop renders a static canvas once and then stops", async () => {
  const { api, frames } = await loadLiquidRuntime();
  let renders = 0;
  const instance = {
    dirty: true,
    needsAnimation: () => false,
    render: () => { renders += 1; }
  };
  api.live.add(instance);

  api.start();
  assert.equal(frames.size, 1);
  const callback = [...frames.values()][0];
  frames.clear();
  callback(16);

  assert.equal(renders, 1);
  assert.equal(instance.dirty, false);
  assert.equal(frames.size, 0);
  assert.equal(api.getRaf(), 0);
});

test("the shared frame loop caps live canvas paints at 30fps", async () => {
  const { api, frames } = await loadLiquidRuntime();
  let renders = 0;
  api.live.add({
    dirty: true,
    needsAnimation: () => true,
    render: () => { renders += 1; }
  });

  api.start();
  let callback = [...frames.values()][0];
  frames.clear();
  callback(16);
  assert.equal(renders, 1);

  callback = [...frames.values()][0];
  frames.clear();
  callback(32);
  assert.equal(renders, 1, "a second display frame must not repaint the canvas");

  callback = [...frames.values()][0];
  frames.clear();
  callback(50);
  assert.equal(renders, 2, "the next 30fps interval repaints the canvas");
});
