const { computeWindowValues, recentPricedPoints } = require("./windows");

const PACE_WINDOW_MS = 60 * 60 * 1000;
const MIN_POINTS = 2;
const MIN_PROJECT_PCT = 5;

function insufficient(cli, reason) {
  return { cli, status: "insufficient_data", reason, windows: [] };
}

function computeRunways({ homeDir, nowMs = Date.now(), limits = [], ambiguousServices = [], extraRoots = {}, dataDir = null } = {}) {
  const ambiguous = new Set(ambiguousServices);
  const services = new Set(limits.map((limit) => limit.cli).filter(Boolean));
  for (const cli of ambiguous) services.add(cli);

  const output = [];
  const usableLimits = limits.filter((limit) => !ambiguous.has(limit.cli));
  const windowValues = computeWindowValues({ homeDir, nowMs, limits: usableLimits, extraRoots, dataDir });
  const points = recentPricedPoints(homeDir, nowMs, extraRoots, dataDir);

  for (const cli of services) {
    if (ambiguous.has(cli)) {
      output.push({ cli, status: "ambiguous_account", reason: "multiple_accounts", windows: [] });
      continue;
    }

    const recent = points.filter((point) => point.cli === cli && point.timestampMs >= nowMs - PACE_WINDOW_MS && point.timestampMs <= nowMs);
    if (recent.length < MIN_POINTS) {
      output.push(insufficient(cli, "not_enough_recent_events"));
      continue;
    }

    const sampleTokens = recent.reduce((sum, point) => sum + (Number(point.tokens) || 0), 0);
    if (!(sampleTokens > 0)) {
      output.push(insufficient(cli, "no_recent_tokens"));
      continue;
    }

    const windows = [];
    for (const value of windowValues.filter((window) => window.cli === cli)) {
      const resetMs = Date.parse(value.resetAt);
      const usedPercent = Number(value.usedPercent) || 0;
      if (!Number.isFinite(resetMs) || resetMs <= nowMs || usedPercent < MIN_PROJECT_PCT || !(value.usedTokens > 0)) continue;

      const remainingTokens = value.usedTokens * (100 - Math.min(usedPercent, 100)) / usedPercent;
      const estimatedMinutes = remainingTokens / sampleTokens * 60;
      const resetMinutes = Math.max(0, (resetMs - nowMs) / 60000);
      windows.push({
        kind: value.kind,
        label: value.label,
        resetAt: value.resetAt,
        estimatedMinutes,
        lastsUntilReset: estimatedMinutes >= resetMinutes
      });
    }

    if (!windows.length) {
      output.push(insufficient(cli, "not_enough_window_usage"));
      continue;
    }

    output.push({
      cli,
      status: "ready",
      sampleWindowMinutes: 60,
      sampleTokens,
      tokensPerHour: sampleTokens,
      windows
    });
  }

  return output;
}

module.exports = { computeRunways, PACE_WINDOW_MS, MIN_POINTS, MIN_PROJECT_PCT };
