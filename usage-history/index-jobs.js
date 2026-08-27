const { mergeAndPrice } = require("./aggregate");
const { buildDiagnostics } = require("./diagnostics");
const { updateUsageIndex } = require("./index");
const { computeRunways } = require("./runway");
const { computeWindowValues } = require("./windows");

function performIndexWork({
  operation,
  homeDir,
  dataDir,
  nowMs = Date.now(),
  extraRoots = {},
  limits = [],
  ambiguousServices = [],
  rangeDays = 30,
  appVersion = null,
  forceRebuild = false
}) {
  const updated = updateUsageIndex({
    homeDir,
    dataDir,
    nowMs,
    extraRoots,
    forceRebuild
  });
  const common = {
    homeDir,
    nowMs,
    extraRoots,
    dataDir,
    usageIndex: updated.index
  };

  if (operation === "runways") {
    return {
      stats: updated.stats,
      runways: computeRunways({
        ...common,
        limits,
        ambiguousServices
      })
    };
  }

  if (operation === "history") {
    const ranges = Array.isArray(rangeDays) ? rangeDays : [rangeDays];
    const windowValues = computeWindowValues({
      ...common,
      limits
    });
    const diagnostics = buildDiagnostics({
      homeDir,
      dataDir,
      extraRoots
    });
    const computedAt = new Date(nowMs).toISOString();
    const payloads = Object.fromEntries(ranges.map((days) => {
      const payload = mergeAndPrice(updated.index.files, {
        rangeDays: days,
        nowMs
      });
      payload.windowValues = windowValues;
      payload.diagnostics = diagnostics;
      payload.appVersion = appVersion;
      payload.computedAt = computedAt;
      return [days, payload];
    }));
    return {
      stats: updated.stats,
      ...(Array.isArray(rangeDays)
        ? { payloads }
        : { payload: payloads[rangeDays] })
    };
  }

  throw new Error(`Unknown usage-index operation: ${operation}`);
}

module.exports = { performIndexWork };
