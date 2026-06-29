const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { computeWindowValues, projectFull, windowDurationMs, transcriptFingerprint } = require("../usage-history/windows");

const NOW = Date.parse("2026-06-25T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

// A codex gpt-5.5 turn (input $5/M, output $30/M). Default 0.2M in + 0.1M out => $4.
function codexTurn(ms, input = 200000, output = 100000) {
  return JSON.stringify({
    timestamp: iso(ms),
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } } }
  });
}

function writeCodexFixture(homeDir, lines) {
  const dir = path.join(homeDir, ".codex", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout-test.jsonl");
  const meta = JSON.stringify({ timestamp: iso(NOW), type: "session_meta", payload: { model: "gpt-5.5" } });
  fs.writeFileSync(file, [meta, ...lines].join("\n"));
  fs.utimesSync(file, new Date(NOW), new Date(NOW));
}

function withTempHome(fn) {
  const prev = { c: process.env.CLAUDE_CONFIG_DIR, x: process.env.CODEX_HOME };
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-windows-"));
  try { return fn(home); }
  finally {
    fs.rmSync(home, { recursive: true, force: true });
    if (prev.c === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev.c;
    if (prev.x === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev.x;
  }
}

test("projectFull: spent exact + remainder at blended rate, clamps at 100, floors below 5%", () => {
  // 8 used over 600k tokens at 40%; blended rate matches => 8 + 900k*rate = 20.
  assert.equal(Math.round(projectFull(8, 600000, 40, 12 / 900000).value), 20);
  assert.equal(projectFull(8, 600000, 40, 12 / 900000).full, false);
  assert.deepEqual(projectFull(8, 1, 100, 1), { value: 8, full: true });
  assert.deepEqual(projectFull(8, 1, 120, 1), { value: 8, full: true }); // clamp >100
  assert.equal(projectFull(8, 1, 4, 1).value, null);                     // below floor
  // No baseline rate -> falls back to the window's own $/token (the naive estimate).
  assert.equal(projectFull(9, 300000, 50, 0).value, 18);                 // 9 + 300k*(9/300k)
});

test("windowDurationMs maps the known window kinds", () => {
  assert.equal(windowDurationMs("fiveHour"), 5 * 3600 * 1000);
  assert.equal(windowDurationMs("week"), 7 * 86400 * 1000);
  assert.equal(windowDurationMs("other"), null);
});

test("computeWindowValues sums only the priced turns inside the window", () => {
  withTempHome((home) => {
    writeCodexFixture(home, [
      codexTurn(NOW - 1 * 86400000), // in weekly window
      codexTurn(NOW - 2 * 86400000), // in weekly window
      codexTurn(NOW - 8 * 86400000)  // older than window start -> excluded
    ]);

    const rows = computeWindowValues({
      homeDir: home,
      nowMs: NOW,
      limits: [{ cli: "codex", label: "weekly", usedPercent: 40, resetAt: iso(NOW + 3600000) }]
    });

    assert.equal(rows.length, 1);
    const w = rows[0];
    assert.equal(w.kind, "week");
    assert.equal(Math.round(w.usedDollars), 8);              // two in-window turns * $4
    assert.equal(Math.round(w.projectedDollars), 20);        // 8 / 0.4
    assert.equal(w.full, false);
  });
});

test("computeWindowValues values the remainder at the blended rate, not the window's mix", () => {
  withTempHome((home) => {
    // In-window turn is output-heavy ($9, expensive); an out-of-window turn is
    // input-heavy ($1.50, cheap) but still in the baseline. Naive $used/pct would
    // project $9/0.5 = $18; valuing the remainder at the blended rate gives less.
    writeCodexFixture(home, [
      codexTurn(NOW - 3600000, 0, 300000),        // in window: 0.3M output => $9
      codexTurn(NOW - 7.5 * 86400000, 300000, 0)  // out of weekly window: 0.3M input => $1.50
    ]);

    const rows = computeWindowValues({
      homeDir: home,
      nowMs: NOW,
      limits: [{ cli: "codex", label: "weekly", usedPercent: 50, resetAt: iso(NOW + 3600000) }]
    });

    assert.equal(rows.length, 1);
    assert.equal(Math.round(rows[0].usedDollars), 9);          // spent part is exact
    // blended rate = $10.50 / 600k tok; remainder 300k tok => +$5.25 => $14.25, not $18.
    assert.ok(Math.abs(rows[0].projectedDollars - 14.25) < 0.01, `got ${rows[0].projectedDollars}`);
  });
});

test("transcriptFingerprint changes when usage is written", () => {
  withTempHome((home) => {
    writeCodexFixture(home, [codexTurn(NOW - 3600000)]);
    const fp1 = transcriptFingerprint(home);
    // A new turn grows the file (size + mtime change) -> fingerprint must differ.
    writeCodexFixture(home, [codexTurn(NOW - 3600000), codexTurn(NOW - 1800000)]);
    const fp2 = transcriptFingerprint(home);
    assert.notEqual(fp1, fp2);
  });
});

test("transcriptFingerprint reflects files in a configured extra root", () => {
  withTempHome((home) => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "um-fp-extra-"));
    try {
      const fp1 = transcriptFingerprint(home, { codex: [extra] });
      fs.writeFileSync(path.join(extra, "r.jsonl"), "{}\n");
      const fp2 = transcriptFingerprint(home, { codex: [extra] });
      assert.notEqual(fp1, fp2);
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });
});

test("computeWindowValues skips windows with no resetAt or unknown label", () => {
  withTempHome((home) => {
    writeCodexFixture(home, [codexTurn(NOW - 3600000)]);
    const rows = computeWindowValues({
      homeDir: home,
      nowMs: NOW,
      limits: [
        { cli: "codex", label: "weekly", usedPercent: 50, resetAt: null },
        { cli: "codex", label: "mystery", usedPercent: 50, resetAt: iso(NOW + 3600000) },
        { cli: "codex", label: "weekly", usedPercent: 50, resetAt: "not-a-date" }
      ]
    });
    assert.equal(rows.length, 0);
  });
});
