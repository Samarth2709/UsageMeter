const { computeWindowValues, recentPricedPoints } = require("./windows");
const { localDay } = require("./day");

const DAILY_PACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DAILY_SAMPLE_DAYS = DAILY_PACE_WINDOW_MS / (24 * 60 * 60 * 1000);
const MIN_POINTS = 2;
const MIN_DAILY_ACTIVE_DAYS = 2;
const MIN_PROJECT_PCT = 5;
const RUNWAY_FORECAST_VERSION = "seven-day-calendar-v1";

function insufficient(cli, reason) {
  return { cli, status: "insufficient_data", reason, windows: [] };
}

function computeRunways({
  homeDir,
  nowMs = Date.now(),
  limits = [],
  ambiguousServices = [],
  extraRoots = {},
  dataDir = null,
  usageIndex = null
} = {}) {
  const ambiguous = new Set(ambiguousServices);
  const services = new Set(limits.map((limit) => limit.cli).filter(Boolean));
  for (const cli of ambiguous) services.add(cli);

  const output = [];
  const usableLimits = limits.filter((limit) => !ambiguous.has(limit.cli));
  const points = recentPricedPoints(
    homeDir,
    nowMs,
    extraRoots,
    dataDir,
    usageIndex
  );
  const windowValues = computeWindowValues({
    homeDir,
    nowMs,
    limits: usableLimits,
    extraRoots,
    dataDir,
    usageIndex,
    points
  });

  for (const cli of services) {
    if (ambiguous.has(cli)) {
      output.push({ cli, status: "ambiguous_account", reason: "multiple_accounts", windows: [] });
      continue;
    }

    const daily = points.filter((point) => point.cli === cli && point.timestampMs >= nowMs - DAILY_PACE_WINDOW_MS && point.timestampMs <= nowMs);
    if (daily.length < MIN_POINTS) {
      output.push(insufficient(cli, "not_enough_daily_events"));
      continue;
    }

    const dailyActiveDays = new Set(daily.map((point) => localDay(point.timestampMs)));
    if (dailyActiveDays.size < MIN_DAILY_ACTIVE_DAYS) {
      output.push(insufficient(cli, "not_enough_active_days"));
      continue;
    }

    const dailySampleTokens = daily.reduce((sum, point) => sum + (Number(point.tokens) || 0), 0);
    if (!(dailySampleTokens > 0)) {
      output.push(insufficient(cli, "no_daily_tokens"));
      continue;
    }

    // This is the primary forecast: a full seven days of elapsed calendar time,
    // including breaks and sleep, rather than assuming an active coding burst lasts
    // indefinitely.
    const tokensPerDay = dailySampleTokens / DAILY_SAMPLE_DAYS;

    const windows = [];
    for (const value of windowValues.filter((window) => window.cli === cli)) {
      const resetMs = Date.parse(value.resetAt);
      const usedPercent = Number(value.usedPercent) || 0;
      if (!Number.isFinite(resetMs) || resetMs <= nowMs || usedPercent < MIN_PROJECT_PCT || !(value.usedTokens > 0)) continue;

      const remainingTokens = value.usedTokens * (100 - Math.min(usedPercent, 100)) / usedPercent;
      const estimatedMinutes = remainingTokens / tokensPerDay * 1440;
      const resetMinutes = Math.max(0, (resetMs - nowMs) / 60000);
      windows.push({
        kind: value.kind,
        label: value.label,
        resetAt: value.resetAt,
        usedPercent,
        usedTokens: value.usedTokens,
        remainingTokens,
        resetMinutes,
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
      forecastVersion: RUNWAY_FORECAST_VERSION,
      dailySampleDays: DAILY_SAMPLE_DAYS,
      dailyActiveDays: dailyActiveDays.size,
      dailySampleTokens,
      tokensPerDay,
      windows
    });
  }

  return output;
}

module.exports = {
  computeRunways,
  DAILY_PACE_WINDOW_MS,
  DAILY_SAMPLE_DAYS,
  MIN_POINTS,
  MIN_DAILY_ACTIVE_DAYS,
  MIN_PROJECT_PCT,
  RUNWAY_FORECAST_VERSION
};
