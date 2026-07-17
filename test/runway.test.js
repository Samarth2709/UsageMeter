const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeRunways } = require("../usage-history/runway");
const { clearPointsCache } = require("../usage-history/windows");

const NOW = Date.parse("2026-06-25T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function writeCodexFixture(home, turns) {
  const dir = path.join(home, ".codex", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session_meta", timestamp: iso(NOW), payload: { model: "gpt-5.5" } }),
    ...turns.map((ms) => JSON.stringify({
      type: "event_msg", timestamp: iso(ms),
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 0 } } }
    }))
  ];
  const file = path.join(dir, "runway.jsonl");
  fs.writeFileSync(file, lines.join("\n"));
  fs.utimesSync(file, new Date(NOW), new Date(NOW));
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-runway-"));
  try { return fn(home); }
  finally { fs.rmSync(home, { recursive: true, force: true }); clearPointsCache(); }
}

test("computes runway pace and caps a forecast at reset", () => withHome((home) => {
  writeCodexFixture(home, [NOW - 30 * 60000, NOW - 10 * 60000]);
  const [runway] = computeRunways({
    homeDir: home,
    nowMs: NOW,
    limits: [
      { cli: "codex", label: "5-hour", usedPercent: 50, resetAt: iso(NOW + 60 * 60000) },
      { cli: "codex", label: "weekly", usedPercent: 20, resetAt: iso(NOW + 60 * 60000) }
    ]
  });
  assert.equal(runway.status, "ready");
  assert.equal(runway.tokensPerHour, 200);
  assert.equal(runway.windows.find((window) => window.kind === "fiveHour").estimatedMinutes, 60);
  assert.equal(runway.windows.find((window) => window.kind === "week").lastsUntilReset, true);
}));

test("returns insufficient data below the confidence threshold or recent event minimum", () => withHome((home) => {
  writeCodexFixture(home, [NOW - 10 * 60000]);
  const [runway] = computeRunways({
    homeDir: home,
    nowMs: NOW,
    limits: [{ cli: "codex", label: "5-hour", usedPercent: 4, resetAt: iso(NOW + 60 * 60000) }]
  });
  assert.equal(runway.status, "insufficient_data");
  assert.equal(runway.reason, "not_enough_recent_events");
}));

test("forecasts a reported weekly allowance when no 5-hour window exists", () => withHome((home) => {
  writeCodexFixture(home, [NOW - 45 * 60000, NOW - 15 * 60000]);
  const [runway] = computeRunways({
    homeDir: home,
    nowMs: NOW,
    limits: [{
      cli: "codex",
      id: "secondary_window",
      label: "weekly",
      durationSeconds: 7 * 24 * 60 * 60,
      usedPercent: 25,
      resetAt: iso(NOW + 6 * 3600000)
    }]
  });

  assert.equal(runway.status, "ready");
  assert.equal(runway.windows.length, 1);
  assert.equal(runway.windows[0].label, "weekly");
  assert.equal(runway.windows[0].kind, "secondary_window");
}));

test("fails closed when one service has multiple eligible accounts", () => withHome((home) => {
  const [runway] = computeRunways({
    homeDir: home,
    nowMs: NOW,
    limits: [{ cli: "codex", label: "5-hour", usedPercent: 50, resetAt: iso(NOW + 60 * 60000) }],
    ambiguousServices: ["codex"]
  });
  assert.deepEqual(runway, { cli: "codex", status: "ambiguous_account", reason: "multiple_accounts", windows: [] });
}));
