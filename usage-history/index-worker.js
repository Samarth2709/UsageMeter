const { performIndexWork } = require("./index-jobs");

const { parentPort } = process;
if (!parentPort) {
  throw new Error("Usage index worker requires an Electron utility-process parent.");
}

parentPort.once("message", (event) => {
  try {
    parentPort.postMessage({
      ok: true,
      result: performIndexWork(event.data)
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  setImmediate(() => process.exit(0));
});
