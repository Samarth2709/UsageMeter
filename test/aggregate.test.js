const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  recordsToContribution, recordsToProjectContribution, contributionForFile, mergeAndPrice, rangeDaysList, scanUsageHistory
} = require("../usage-history/aggregate");

test("recordsToContribution groups buckets by day and cli::model", () => {
  const recs = [
    { day: "2026-06-16", cli: "claude", model: "claude-opus-4-8", inputTokens: 10, cachedReadTokens: 1, cacheWriteTokens: 2, outputTokens: 3 },
    { day: "2026-06-16", cli: "claude", model: "claude-opus-4-8", inputTokens: 5, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }
  ];
  const c = recordsToContribution(recs);
  assert.deepEqual(c["2026-06-16"]["claude::claude-opus-4-8"], { inputTokens: 15, cachedReadTokens: 1, cacheWriteTokens: 2, outputTokens: 4, calls: 2 });
});

test("recordsToProjectContribution retains an explicit project and falls back to Unattributed", () => {
  const records = [
    { day: "2026-06-16", cli: "codex", model: "gpt-5.5", projectPath: "/Users/you/Projects/kernel", inputTokens: 10, outputTokens: 1 },
    { day: "2026-06-16", cli: "codex", model: "gpt-5.5", inputTokens: 5, outputTokens: 1 }
  ];
  const contribution = recordsToProjectContribution(records, "/Users/you/.codex/sessions/a.jsonl", "codex");
  assert.equal(contribution["2026-06-16"]["path:/Users/you/Projects/kernel"].label, "kernel");
  assert.equal(contribution["2026-06-16"].unattributed.label, "Unattributed");
});

test("contributionForFile picks the parser from the cli tag", () => {
  const claudeText = JSON.stringify({ type: "assistant", timestamp: "2026-06-16T18:00:00.000Z", message: { id: "m1", model: "claude-haiku-4-5", usage: { input_tokens: 4, output_tokens: 2 } } });
  const c = contributionForFile("/anywhere/s.jsonl", claudeText, "claude");
  assert.ok(c["2026-06-16"]["claude::claude-haiku-4-5"]);

  // Codex sessions outside ~/.codex must still parse as codex (the original bug:
  // an Orca path like .../codex-runtime-home/... was misparsed as claude).
  const codexText = [
    JSON.stringify({ type: "session_meta", timestamp: "2026-06-16T18:00:00.000Z", payload: { model: "gpt-5.5-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-16T18:00:01.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } } } })
  ].join("\n");
  const cc = contributionForFile("/Library/Application Support/orca/codex-runtime-home/home/sessions/x.jsonl", codexText, "codex");
  assert.ok(cc["2026-06-16"]["codex::gpt-5.5-codex"]);
});

test("counts model calls and computes cost-per-call averages", () => {
  // 3 calls to the same model on one day: total $X over 3 calls.
  const files = {
    "/f1": { cli: "codex", contribution: { "2026-06-16": { "codex::gpt-5.5": { inputTokens: 3_000_000, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, calls: 3 } } } }
  };
  const now = new Date(2026, 5, 16, 12, 0, 0).getTime();
  const res = mergeAndPrice(files, { rangeDays: 7, nowMs: now });
  // 3M input @ $5/M = $15 over 3 calls = $5/call
  assert.equal(res.range.tokens.calls, 3);
  assert.ok(Math.abs(res.range.avgCostPerCall - 5) < 1e-9);
  const model = res.range.byModel[0];
  assert.equal(model.calls, 3);
  assert.ok(Math.abs(model.costPerCall - 5) < 1e-9);
  assert.ok(Math.abs(res.today.costPerCall - 5) < 1e-9);
});

test("mergeAndPrice retains unknown-model tokens without fabricating dollars", () => {
  const files = {
    "/f1": { cli: "claude", contribution: { "2026-06-16": { "claude::weird-model": { inputTokens: 1_000_000, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, calls: 1 } } } }
  };
  const now = new Date(2026, 5, 16, 12, 0, 0).getTime();
  const res = mergeAndPrice(files, { rangeDays: 7, nowMs: now });
  assert.equal(res.range.days.length, 7);
  const today = res.range.days.find((d) => d.day === "2026-06-16");
  assert.equal(today.tokens.input, 1_000_000);
  assert.equal(res.range.dollars, 0);
  assert.equal(res.range.pricing.complete, false);
  assert.equal(res.range.pricing.unpricedTokens, 1_000_000);
  assert.deepEqual(res.flags.unpricedModels, [{ cli: "claude", model: "weird-model" }]);
  assert.ok(res.today.tokens.total >= 1_000_000);
});

test("project totals reconcile with the range total and preserve paths only as metadata", () => {
  const buckets = { inputTokens: 1_000_000, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, calls: 2 };
  const files = {
    "/f1": {
      cli: "codex",
      contribution: { "2026-06-16": { "codex::gpt-5.5": buckets } },
      projectContribution: {
        "2026-06-16": {
          "path:/Users/you/Projects/kernel": {
            key: "path:/Users/you/Projects/kernel", path: "/Users/you/Projects/kernel", label: "kernel", parentLabel: "Projects",
            models: { "codex::gpt-5.5": buckets }
          }
        }
      }
    }
  };
  const now = new Date(2026, 5, 16, 12, 0, 0).getTime();
  const result = mergeAndPrice(files, { rangeDays: 7, nowMs: now });
  assert.equal(result.range.byProject.length, 1);
  assert.equal(result.range.byProject[0].label, "kernel");
  assert.equal(result.range.byProject[0].path, "/Users/you/Projects/kernel");
  assert.equal(result.range.byProject.reduce((sum, project) => sum + project.dollars, 0), result.range.dollars);
});

test("scanUsageHistory skips unchanged files and recomputes changed ones", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-scan-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "um-scan-data-"));
  const dir = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "s.jsonl");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date(now).toISOString(), message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 10 } } }));

  const first = scanUsageHistory({ homeDir: home, dataDir, nowMs: now, rangeDays: 7 });
  assert.equal(first.today.tokens.input, 100);

  const second = scanUsageHistory({ homeDir: home, dataDir, nowMs: now, rangeDays: 7 });
  assert.equal(second.today.tokens.input, 100);
});

test("scanUsageHistory counts usage from a configured extra Codex root", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-scan-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "um-scan-data-"));
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "um-extra-codex-"));
  const now = Date.now();
  const ts = new Date(now).toISOString();
  fs.writeFileSync(path.join(extra, "r.jsonl"), [
    JSON.stringify({ type: "session_meta", timestamp: ts, payload: { model: "gpt-5.5" } }),
    JSON.stringify({ type: "event_msg", timestamp: ts, payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000000, cached_input_tokens: 0, output_tokens: 100000 } } } })
  ].join("\n"));

  // Without the extra root: nothing found. With it: the session is parsed and priced.
  const without = scanUsageHistory({ homeDir: home, dataDir, nowMs: now, rangeDays: 7 });
  assert.equal(without.range.tokens.total, 0);

  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "um-scan-data2-"));
  const withRoot = scanUsageHistory({ homeDir: home, dataDir: dataDir2, nowMs: now, rangeDays: 7, extraRoots: { codex: [extra] } });
  assert.ok(withRoot.range.tokens.total > 0, "extra-root usage should be counted");
  assert.ok(withRoot.range.dollars > 0, "extra-root usage should be priced");
  const codexModel = withRoot.range.byModel.find((m) => m.cli === "codex");
  assert.ok(codexModel && codexModel.dollars > 0, "extra-root codex usage should be priced");
});

test("scanUsageHistory re-parses a cached file when its CLI tag changes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-scan-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "um-scan-data-"));
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "um-extra-root-"));
  const now = Date.now();
  const ts = new Date(now).toISOString();

  try {
    fs.writeFileSync(path.join(extra, "r.jsonl"), [
      JSON.stringify({ type: "session_meta", timestamp: ts, payload: { model: "gpt-5.5" } }),
      JSON.stringify({ type: "event_msg", timestamp: ts, payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } } })
    ].join("\n"));

    const misclassified = scanUsageHistory({
      homeDir: home,
      dataDir,
      nowMs: now,
      rangeDays: 7,
      extraRoots: { claude: [extra] }
    });
    assert.equal(misclassified.range.tokens.total, 0);

    const corrected = scanUsageHistory({
      homeDir: home,
      dataDir,
      nowMs: now,
      rangeDays: 7,
      extraRoots: { codex: [extra] }
    });
    assert.equal(corrected.range.tokens.total, 110);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
  }
});

test("rangeDaysList steps through local calendar days across daylight saving time", () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "America/New_York";

  try {
    assert.deepEqual(
      rangeDaysList(3, Date.parse("2026-03-10T00:30:00-04:00")),
      ["2026-03-08", "2026-03-09", "2026-03-10"]
    );
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});
