const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PREDICTION_SAMPLE_MS,
  emptyEvaluationState,
  selectRunwayEvaluationEvents
} = require("../usage-history/runway-evaluation");

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function limit(overrides = {}) {
  return {
    cli: "codex",
    accountId: "codex-main",
    id: "primary_window",
    label: "5-hour",
    usedPercent: 40,
    resetAt: iso(NOW + 4 * 60 * 60 * 1000),
    observedAt: iso(NOW),
    fresh: true,
    providerLimitReached: false,
    rateLimitReachedType: null,
    ...overrides
  };
}

function runway(overrides = {}) {
  return {
    cli: "codex",
    status: "ready",
    forecastVersion: "seven-day-calendar-v1",
    dailySampleDays: 7,
    dailyActiveDays: 5,
    dailySampleTokens: 7_000_000,
    tokensPerDay: 1_000_000,
    windows: [{
      kind: "primary_window",
      label: "5-hour",
      resetAt: iso(NOW + 4 * 60 * 60 * 1000),
      usedPercent: 40,
      usedTokens: 400_000,
      remainingTokens: 600_000,
      resetMinutes: 240,
      estimatedMinutes: 95,
      lastsUntilReset: false
    }],
    ...overrides
  };
}

function evaluate({ nowMs = NOW, state, runways = [runway()], limits = [limit()] } = {}) {
  return selectRunwayEvaluationEvents(
    { runways, limits },
    { nowMs, state: state || emptyEvaluationState() }
  );
}

test("logs an actionable prediction with the inputs needed for later variance analysis", () => {
  const result = evaluate();

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].event, "prediction");
  assert.equal(result.events[0].predictedAt, iso(NOW));
  assert.equal(result.events[0].predictedLimitReachedAt, iso(NOW + 95 * 60 * 1000));
  assert.equal(result.events[0].forecastVersion, "seven-day-calendar-v1");
  assert.equal(result.events[0].usedPercent, 40);
  assert.equal(result.events[0].usedTokens, 400_000);
  assert.equal(result.events[0].remainingTokens, 600_000);
  assert.equal(result.events[0].tokensPerDay, 1_000_000);
  assert.equal(result.events[0].dailyActiveDays, 5);
  assert.equal(result.events[0].resetAt, iso(NOW + 4 * 60 * 60 * 1000));
  assert.equal(Object.keys(result.state.windows).length, 1);
});

test("samples a prediction only after fifteen minutes or a five-minute ETA shift", () => {
  const first = evaluate();
  const unchanged = evaluate({
    nowMs: NOW + 60 * 1000,
    state: first.state,
    limits: [limit({ observedAt: iso(NOW + 60 * 1000) })],
    runways: [runway({
      windows: [{
        ...runway().windows[0],
        estimatedMinutes: 94
      }]
    })]
  });
  assert.deepEqual(unchanged.events, []);

  const shifted = evaluate({
    nowMs: NOW + 2 * 60 * 1000,
    state: unchanged.state,
    limits: [limit({ observedAt: iso(NOW + 2 * 60 * 1000) })],
    runways: [runway({
      windows: [{
        ...runway().windows[0],
        estimatedMinutes: 100
      }]
    })]
  });
  assert.equal(shifted.events.length, 1);
  assert.equal(shifted.events[0].event, "prediction");

  const periodic = evaluate({
    nowMs: NOW + 2 * 60 * 1000 + PREDICTION_SAMPLE_MS,
    state: shifted.state,
    limits: [limit({ observedAt: iso(NOW + 2 * 60 * 1000 + PREDICTION_SAMPLE_MS) })],
    runways: [runway({
      windows: [{
        ...runway().windows[0],
        estimatedMinutes: 85
      }]
    })]
  });
  assert.equal(periodic.events.length, 1);
  assert.equal(periodic.events[0].event, "prediction");
});

test("matches the first observed limit hit to first and latest predictions", () => {
  const first = evaluate({
    runways: [runway({
      windows: [{
        ...runway().windows[0],
        estimatedMinutes: 90
      }]
    })]
  });
  const belowAt = NOW + 80 * 60 * 1000;
  const below = evaluate({
    nowMs: belowAt,
    state: JSON.parse(JSON.stringify(first.state)),
    runways: [],
    limits: [limit({ usedPercent: 99, observedAt: iso(belowAt) })]
  });
  assert.deepEqual(below.events, []);

  const actualAt = NOW + 87 * 60 * 1000;
  const actual = evaluate({
    nowMs: actualAt,
    state: below.state,
    runways: [],
    limits: [limit({
      usedPercent: 100,
      observedAt: iso(actualAt),
      providerLimitReached: true,
      rateLimitReachedType: "primary_window"
    })]
  });

  assert.equal(actual.events.length, 1);
  assert.equal(actual.events[0].event, "actual_limit_reached");
  assert.equal(actual.events[0].actualLimitReachedAt, iso(actualAt));
  assert.equal(actual.events[0].actualTimeBasis, "first_observed_at_or_above_100_percent");
  assert.equal(actual.events[0].lastBelowLimitAt, iso(belowAt));
  assert.equal(actual.events[0].predictedLimitReachedAt, iso(NOW + 90 * 60 * 1000));
  assert.equal(actual.events[0].forecastVersion, "seven-day-calendar-v1");
  assert.equal(actual.events[0].predictionErrorMinutes, -3);
  assert.equal(actual.events[0].firstPrediction.predictionErrorMinutes, -3);
  assert.equal(actual.events[0].providerLimitReached, true);
});

test("logs a reset without an observed hit as an unmatched outcome", () => {
  const resetAt = NOW + 60 * 60 * 1000;
  const first = evaluate({
    limits: [limit({ resetAt: iso(resetAt) })],
    runways: [runway({
      windows: [{
        ...runway().windows[0],
        resetAt: iso(resetAt),
        estimatedMinutes: 30
      }]
    })]
  });
  const afterReset = evaluate({
    nowMs: resetAt + 60 * 1000,
    state: first.state,
    runways: [],
    limits: []
  });

  assert.equal(afterReset.events.length, 1);
  assert.equal(afterReset.events[0].event, "window_closed");
  assert.equal(afterReset.events[0].outcome, "not_observed_before_reset");
  assert.equal(afterReset.events[0].actualLimitReachedAt, null);
  assert.equal(afterReset.events[0].predictedLimitReachedAt, iso(NOW + 30 * 60 * 1000));
  assert.deepEqual(afterReset.state.windows, {});
});

test("does not learn from stale provider windows", () => {
  const result = evaluate({
    limits: [limit({ fresh: false })]
  });

  assert.deepEqual(result.events, []);
  assert.deepEqual(result.state.windows, {});
});

test("ignores an observation older than the last persisted provider sample", () => {
  const first = evaluate();
  const newerAt = NOW + 10 * 60 * 1000;
  const newer = evaluate({
    nowMs: newerAt,
    state: first.state,
    runways: [],
    limits: [limit({ usedPercent: 70, observedAt: iso(newerAt) })]
  });
  const older = evaluate({
    nowMs: newerAt + 60 * 1000,
    state: newer.state,
    runways: [runway()],
    limits: [limit({ usedPercent: 100, observedAt: iso(NOW + 5 * 60 * 1000) })]
  });

  assert.deepEqual(older.events, []);
  assert.equal(Object.values(older.state.windows)[0].lastUsedPercent, 70);
  assert.equal(Object.values(older.state.windows)[0].actualLimitReachedAt, null);
});
