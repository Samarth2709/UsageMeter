const test = require("node:test");
const assert = require("node:assert/strict");
const { selectRunwayAlerts, markRunwayAlertSent } = require("../usage-history/runway-alerts");

const NOW = Date.parse("2026-07-20T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function riskyRunway(overrides = {}) {
  return {
    cli: "codex",
    status: "ready",
    tokensPerDay: 640000,
    windows: [{
      kind: "fiveHour",
      label: "5-hour",
      resetAt: iso(NOW + 4 * 3600000),
      estimatedMinutes: 95,
      lastsUntilReset: false,
      ...overrides
    }]
  };
}

test("selects a ready forecast that exhausts before its provider reset", () => {
  const { alerts } = selectRunwayAlerts([riskyRunway()], { nowMs: NOW });

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].cli, "codex");
  assert.equal(alerts[0].label, "5-hour");
  assert.equal(alerts[0].tokensPerDay, 640000);
  assert.equal(alerts[0].exhaustsAt, iso(NOW + 95 * 60000));
});

test("does not alert when a forecast lasts through reset or lacks confidence", () => {
  const lasting = riskyRunway({ lastsUntilReset: true });
  const insufficient = { cli: "claude", status: "insufficient_data", windows: [riskyRunway().windows[0]] };

  assert.deepEqual(selectRunwayAlerts([lasting, insufficient], { nowMs: NOW }).alerts, []);
});

test("does not repeat an alert for the same provider window and reset", () => {
  const first = selectRunwayAlerts([riskyRunway()], { nowMs: NOW });
  const state = markRunwayAlertSent(first.state, first.alerts[0], iso(NOW));
  const second = selectRunwayAlerts([riskyRunway()], { nowMs: NOW + 60000, state });

  assert.deepEqual(second.alerts, []);
});

test("permits a new alert after the old reset has passed", () => {
  const first = selectRunwayAlerts([riskyRunway()], { nowMs: NOW });
  const state = markRunwayAlertSent(first.state, first.alerts[0], iso(NOW));
  const future = NOW + 5 * 3600000;
  const nextWindow = riskyRunway({ resetAt: iso(future + 4 * 3600000) });
  const second = selectRunwayAlerts([nextWindow], { nowMs: future, state });

  assert.equal(second.pruned, true);
  assert.equal(second.alerts.length, 1);
});
