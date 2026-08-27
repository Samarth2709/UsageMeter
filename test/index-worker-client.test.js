const { EventEmitter } = require("node:events");
const test = require("node:test");
const assert = require("node:assert/strict");

const { runIndexWorkerProcess } = require("../usage-history/index-worker-client");

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
    this.request = null;
  }

  kill() {
    this.killed = true;
    return true;
  }

  postMessage(request) {
    this.request = request;
  }
}

function startWorker() {
  const child = new FakeWorker();
  const activeWorkers = new Set();
  const promise = runIndexWorkerProcess({
    fork: () => child,
    workerPath: "/worker.js",
    cwd: "/app",
    request: { operation: "runways" },
    activeWorkers,
    timeoutMs: 1000
  });
  return { activeWorkers, child, promise };
}

test("index worker errors reject the job and exit performs active-worker cleanup", async () => {
  const { activeWorkers, child, promise } = startWorker();
  const rejected = assert.rejects(promise, /fatal worker failure/);
  child.emit("spawn");
  assert.deepEqual(child.request, { operation: "runways" });

  child.emit("error", new Error("fatal worker failure"));
  assert.equal(activeWorkers.has(child), true);

  child.emit("exit", 1);
  await rejected;
  assert.equal(activeWorkers.has(child), false);
});

test("index worker messages resolve the job and stop the worker", async () => {
  const { activeWorkers, child, promise } = startWorker();
  child.emit("spawn");
  child.emit("message", { ok: true, result: { runways: [] } });

  assert.equal(child.killed, true);
  assert.equal(activeWorkers.has(child), true);
  child.emit("exit", 0);
  assert.deepEqual(await promise, { runways: [] });
  assert.equal(activeWorkers.has(child), false);
});

test("a timed-out worker blocks the serialized queue until exit", async () => {
  const child = new FakeWorker();
  const activeWorkers = new Set();
  const first = runIndexWorkerProcess({
    fork: () => child,
    workerPath: "/worker.js",
    cwd: "/app",
    request: { operation: "runways" },
    activeWorkers,
    timeoutMs: 10
  });
  const rejected = assert.rejects(first, /timed out/);
  let nextStarted = false;
  const next = first.catch(() => {}).then(() => {
    nextStarted = true;
  });
  child.emit("spawn");

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(child.killed, true);
  assert.equal(activeWorkers.has(child), true);
  assert.equal(nextStarted, false);

  child.emit("exit", 0);
  await rejected;
  await next;
  assert.equal(activeWorkers.has(child), false);
  assert.equal(nextStarted, true);
});
