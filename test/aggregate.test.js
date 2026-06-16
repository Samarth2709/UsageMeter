const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  recordsToContribution, contributionForFile, mergeAndPrice, scanUsageHistory
} = require("../usage-history/aggregate");

test("recordsToContribution groups buckets by day and cli::model", () => {
  const recs = [
    { day: "2026-06-16", cli: "claude", model: "claude-opus-4-8", inputTokens: 10, cachedReadTokens: 1, cacheWriteTokens: 2, outputTokens: 3 },
    { day: "2026-06-16", cli: "claude", model: "claude-opus-4-8", inputTokens: 5, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }
  ];
  const c = recordsToContribution(recs);
  assert.deepEqual(c["2026-06-16"]["claude::claude-opus-4-8"], { inputTokens: 15, cachedReadTokens: 1, cacheWriteTokens: 2, outputTokens: 4 });
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

test("mergeAndPrice sums a range and computes dollars + flags unknown models", () => {
  const files = {
    "/f1": { cli: "claude", contribution: { "2026-06-16": { "claude::weird-model": { inputTokens: 1_000_000, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } } }
  };
  const now = new Date(2026, 5, 16, 12, 0, 0).getTime();
  const res = mergeAndPrice(files, { rangeDays: 7, nowMs: now });
  assert.equal(res.range.days.length, 7);
  const today = res.range.days.find((d) => d.day === "2026-06-16");
  assert.equal(today.tokens.input, 1_000_000);
  assert.ok(res.flags.unknownModels.includes("weird-model"));
  assert.ok(res.today.tokens.total >= 1_000_000);
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
