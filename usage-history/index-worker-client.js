function runIndexWorkerProcess({
  fork,
  workerPath,
  cwd,
  request,
  activeWorkers,
  timeoutMs = 300000
}) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], {
      cwd,
      serviceName: "Usage Meter Indexer",
      stdio: "ignore"
    });
    activeWorkers.add(child);
    let settled = false;
    let outcome = null;
    let stopping = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeWorkers.delete(child);
      if (outcome?.error) reject(outcome.error);
      else if (outcome) resolve(outcome.result);
      else reject(new Error("Usage index worker stopped without a result."));
    };

    const errorValue = (error) => (
      error instanceof Error ? error : new Error(String(error))
    );
    const stopAfter = (nextOutcome, { kill = true } = {}) => {
      if (settled || outcome) return;
      outcome = nextOutcome;
      stopping = true;
      clearTimeout(timeout);
      if (!kill) return;
      try {
        child.kill();
      } catch (error) {
        outcome = { error: errorValue(error) };
      }
    };

    const timeout = setTimeout(() => {
      stopAfter({ error: new Error("Usage index worker timed out.") });
    }, timeoutMs);

    child.once("message", (message) => {
      stopAfter(message?.ok
        ? { result: message.result }
        : { error: new Error(message?.error || "Usage index worker failed.") });
    });
    child.once("error", (error) => {
      stopAfter({ error: errorValue(error) }, { kill: false });
    });
    child.once("exit", (code) => {
      if (settled) return;
      if (!outcome) outcome = { error: new Error(`Usage index worker exited with code ${code}.`) };
      finish();
    });
    child.once("spawn", () => {
      if (stopping) {
        try { child.kill(); } catch { /* wait for the required exit event */ }
        return;
      }
      try {
        child.postMessage(request);
      } catch (error) {
        stopAfter({ error: errorValue(error) });
      }
    });
  });
}

module.exports = { runIndexWorkerProcess };
