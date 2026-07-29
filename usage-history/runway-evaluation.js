const { usageWindowKey } = require("../usage-windows");

const EVALUATION_STATE_VERSION = 1;
const EVALUATION_EVENT_SCHEMA_VERSION = 1;
const PREDICTION_SAMPLE_MS = 15 * 60 * 1000;
const PREDICTION_SHIFT_MS = 5 * 60 * 1000;

function emptyEvaluationState() {
  return { version: EVALUATION_STATE_VERSION, windows: {} };
}

function iso(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeEvaluationState(state) {
  if (
    !state ||
    state.version !== EVALUATION_STATE_VERSION ||
    !state.windows ||
    typeof state.windows !== "object" ||
    Array.isArray(state.windows)
  ) {
    return emptyEvaluationState();
  }

  const windows = {};
  for (const [key, value] of Object.entries(state.windows)) {
    const resetAt = iso(value?.resetAt);
    if (!resetAt || !value?.cli) continue;
    windows[key] = {
      ...value,
      resetAt,
      firstPrediction: value.firstPrediction || null,
      latestPrediction: value.latestPrediction || null,
      actualLimitReachedAt: iso(value.actualLimitReachedAt)
    };
  }
  return { version: EVALUATION_STATE_VERSION, windows };
}

function runwayEvaluationKey(cli, window) {
  const resetAt = iso(window?.resetAt);
  const kind = String(window?.kind || usageWindowKey(window) || "allowance").trim().toLowerCase();
  return cli && resetAt ? [cli, kind, resetAt].join("|") : null;
}

function eventId(key, event, at) {
  return [key, event, at].join("|");
}

function comparison(prediction, actualMs) {
  if (!prediction) return null;
  const predictedMs = Date.parse(prediction.predictedLimitReachedAt);
  return {
    predictedAt: prediction.predictedAt,
    predictedLimitReachedAt: prediction.predictedLimitReachedAt,
    forecastVersion: prediction.forecastVersion || null,
    predictionErrorMinutes: Number.isFinite(predictedMs) ? (actualMs - predictedMs) / 60000 : null
  };
}

function predictionEvent(key, entry, runway, window, limit, nowMs) {
  const predictedAt = new Date(nowMs).toISOString();
  const predictedLimitReachedAt = new Date(nowMs + Number(window.estimatedMinutes) * 60000).toISOString();
  return {
    schemaVersion: EVALUATION_EVENT_SCHEMA_VERSION,
    eventId: eventId(key, "prediction", predictedAt),
    event: "prediction",
    windowKey: key,
    cli: entry.cli,
    accountId: entry.accountId || null,
    kind: entry.kind,
    label: entry.label,
    resetAt: entry.resetAt,
    observedAt: entry.lastObservedAt,
    predictedAt,
    predictedLimitReachedAt,
    forecastVersion: runway.forecastVersion || "unknown",
    predictionHorizonMinutes: Number(window.estimatedMinutes),
    usedPercent: Number(limit.usedPercent) || 0,
    usedTokens: Number(window.usedTokens) || 0,
    remainingTokens: Number(window.remainingTokens) || 0,
    resetMinutes: Number(window.resetMinutes) || 0,
    tokensPerDay: Number(runway.tokensPerDay) || 0,
    dailySampleDays: Number(runway.dailySampleDays) || 0,
    dailyActiveDays: Number(runway.dailyActiveDays) || 0,
    dailySampleTokens: Number(runway.dailySampleTokens) || 0
  };
}

function actualEvent(key, entry, limit, actualAt) {
  const actualMs = Date.parse(actualAt);
  const first = comparison(entry.firstPrediction, actualMs);
  const latest = comparison(entry.latestPrediction, actualMs);
  const lowerBoundMs = Date.parse(entry.lastBelowLimitAt);
  return {
    schemaVersion: EVALUATION_EVENT_SCHEMA_VERSION,
    eventId: eventId(key, "actual_limit_reached", actualAt),
    event: "actual_limit_reached",
    windowKey: key,
    cli: entry.cli,
    accountId: entry.accountId || null,
    kind: entry.kind,
    label: entry.label,
    resetAt: entry.resetAt,
    actualLimitReachedAt: actualAt,
    actualTimeBasis: "first_observed_at_or_above_100_percent",
    lastBelowLimitAt: entry.lastBelowLimitAt || null,
    observationIntervalMinutes: Number.isFinite(lowerBoundMs) ? (actualMs - lowerBoundMs) / 60000 : null,
    predictedAt: latest?.predictedAt || null,
    predictedLimitReachedAt: latest?.predictedLimitReachedAt || null,
    forecastVersion: latest?.forecastVersion || null,
    predictionErrorMinutes: latest?.predictionErrorMinutes ?? null,
    firstPrediction: first,
    latestPrediction: latest,
    usedPercent: Number(limit.usedPercent) || 0,
    providerLimitReached: limit.providerLimitReached === true,
    rateLimitReachedType: limit.rateLimitReachedType || null
  };
}

function closedEvent(key, entry, closedAt) {
  return {
    schemaVersion: EVALUATION_EVENT_SCHEMA_VERSION,
    eventId: eventId(key, "window_closed", closedAt),
    event: "window_closed",
    windowKey: key,
    cli: entry.cli,
    accountId: entry.accountId || null,
    kind: entry.kind,
    label: entry.label,
    resetAt: entry.resetAt,
    closedAt,
    outcome: "not_observed_before_reset",
    actualLimitReachedAt: null,
    lastObservedAt: entry.lastObservedAt || null,
    lastBelowLimitAt: entry.lastBelowLimitAt || null,
    predictedAt: entry.latestPrediction?.predictedAt || null,
    predictedLimitReachedAt: entry.latestPrediction?.predictedLimitReachedAt || null,
    forecastVersion: entry.latestPrediction?.forecastVersion || null,
    predictionCount: Number(entry.predictionCount) || 0
  };
}

function selectRunwayEvaluationEvents({ runways = [], limits = [] } = {}, { nowMs = Date.now(), state } = {}) {
  const normalized = normalizeEvaluationState(state);
  const windows = { ...normalized.windows };
  const events = [];
  const nowAt = new Date(nowMs).toISOString();
  let changed = false;

  for (const [key, entry] of Object.entries(windows)) {
    if (Date.parse(entry.resetAt) > nowMs) continue;
    if (!entry.actualLimitReachedAt && entry.latestPrediction) {
      events.push(closedEvent(key, entry, nowAt));
    }
    delete windows[key];
    changed = true;
  }

  const observed = new Map();
  for (const limit of limits) {
    if (limit?.fresh !== true) continue;
    const key = runwayEvaluationKey(limit.cli, limit);
    if (!key || Date.parse(limit.resetAt) <= nowMs) continue;
    observed.set(key, limit);
  }

  for (const [key, limit] of observed) {
    const observationAt = iso(limit.observedAt) || nowAt;
    const observationMs = Date.parse(observationAt);
    const kind = String(limit.id || usageWindowKey(limit) || "allowance").trim();
    const existing = windows[key] || null;
    const previousObservationAt = existing?.lastObservedAt || null;
    const previousObservationMs = Date.parse(existing?.lastObservedAt);
    if (Number.isFinite(previousObservationMs) && observationMs < previousObservationMs) {
      observed.delete(key);
      continue;
    }
    const entry = existing || {
      cli: limit.cli,
      accountId: limit.accountId || null,
      kind,
      label: limit.label || "Allowance",
      resetAt: iso(limit.resetAt),
      firstSeenAt: observationAt,
      lastObservedAt: null,
      lastBelowLimitAt: null,
      firstPrediction: null,
      latestPrediction: null,
      predictionCount: 0,
      actualLimitReachedAt: null
    };

    const previousUsedPercent = Number(entry.lastUsedPercent);
    let actualRecorded = false;
    entry.accountId = limit.accountId || entry.accountId || null;
    entry.label = limit.label || entry.label;
    entry.lastObservedAt = observationAt;
    entry.lastUsedPercent = Number(limit.usedPercent) || 0;
    if (entry.lastUsedPercent < 100) entry.lastBelowLimitAt = observationAt;

    if (entry.lastUsedPercent >= 100 && !entry.actualLimitReachedAt) {
      const reached = actualEvent(key, entry, limit, observationAt);
      events.push(reached);
      entry.actualLimitReachedAt = observationAt;
      actualRecorded = true;
    }

    windows[key] = entry;
    if (
      !existing ||
      observationAt !== previousObservationAt ||
      entry.lastUsedPercent !== previousUsedPercent ||
      actualRecorded
    ) {
      changed = true;
    }
  }

  for (const runway of runways) {
    if (runway?.status !== "ready") continue;
    for (const window of runway.windows || []) {
      if (window?.lastsUntilReset || !(Number(window?.estimatedMinutes) >= 0)) continue;
      const key = runwayEvaluationKey(runway.cli, window);
      const limit = key ? observed.get(key) : null;
      const entry = key ? windows[key] : null;
      if (!key || !limit || !entry || entry.actualLimitReachedAt || entry.lastUsedPercent >= 100) continue;

      const predictedMs = nowMs + Number(window.estimatedMinutes) * 60000;
      const latestPredictedMs = Date.parse(entry.latestPrediction?.predictedLimitReachedAt);
      const latestLoggedMs = Date.parse(entry.latestPrediction?.predictedAt);
      const first = !entry.latestPrediction;
      const sampleDue = Number.isFinite(latestLoggedMs) && nowMs - latestLoggedMs >= PREDICTION_SAMPLE_MS;
      const shifted = Number.isFinite(latestPredictedMs) && Math.abs(predictedMs - latestPredictedMs) >= PREDICTION_SHIFT_MS;
      if (!first && !sampleDue && !shifted) continue;

      const event = predictionEvent(key, entry, runway, window, limit, nowMs);
      events.push(event);
      const compact = {
        predictedAt: event.predictedAt,
        predictedLimitReachedAt: event.predictedLimitReachedAt,
        forecastVersion: event.forecastVersion
      };
      if (!entry.firstPrediction) entry.firstPrediction = compact;
      entry.latestPrediction = compact;
      entry.predictionCount = (Number(entry.predictionCount) || 0) + 1;
      changed = true;
    }
  }

  return {
    events,
    state: { version: EVALUATION_STATE_VERSION, windows },
    changed
  };
}

module.exports = {
  EVALUATION_STATE_VERSION,
  EVALUATION_EVENT_SCHEMA_VERSION,
  PREDICTION_SAMPLE_MS,
  PREDICTION_SHIFT_MS,
  emptyEvaluationState,
  normalizeEvaluationState,
  runwayEvaluationKey,
  selectRunwayEvaluationEvents
};
