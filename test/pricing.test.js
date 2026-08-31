const test = require("node:test");
const assert = require("node:assert");
const { rateKeyForModel, priceRecord } = require("../usage-history/pricing");

test("maps Claude/Codex model ids to rate keys", () => {
  assert.equal(rateKeyForModel("claude", "claude-fable-5"), "claude-fable");
  assert.equal(rateKeyForModel("claude", "claude-opus-4-8"), "claude-opus");
  assert.equal(rateKeyForModel("claude", "claude-sonnet-4-6"), "claude-sonnet");
  assert.equal(rateKeyForModel("claude", "claude-sonnet-5", "2026-07-25"), "claude-sonnet-5");
  assert.equal(rateKeyForModel("claude", "claude-sonnet-5", "2026-09-01"), "claude-sonnet-5");
  assert.equal(rateKeyForModel("claude", "claude-haiku-4-5"), "claude-haiku");
  assert.equal(rateKeyForModel("codex", "gpt-5.5-codex"), "gpt-5.5");
  assert.equal(rateKeyForModel("codex", "gpt-5.4"), "gpt-5.4");
  assert.equal(rateKeyForModel("codex", "gpt-5.4-mini"), "gpt-5.4-mini");
  assert.equal(rateKeyForModel("codex", "gpt-5.4-mini-2026-03-17"), "gpt-5.4-mini");
  assert.equal(rateKeyForModel("codex", "gpt-5.6"), "gpt-5.6-sol");
  assert.equal(rateKeyForModel("codex", "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(rateKeyForModel("codex", "gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(rateKeyForModel("codex", "gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(rateKeyForModel("codex", "gpt-5.6-sol-pro"), null);
  assert.equal(rateKeyForModel("codex", "gpt-5.7-new"), null);
  assert.equal(rateKeyForModel("codex", "mystery-model"), null);
});

test("prices a known model by bucket", () => {
  const r = priceRecord("claude", "claude-opus-4-8", {
    inputTokens: 1_000_000, cachedReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000, outputTokens: 1_000_000
  });
  assert.equal(r.modelKnown, true);
  assert.equal(r.rateKey, "claude-opus");
  // Opus 4.x: $5 input + $0.50 cached read + $6.25 cache write + $25 output
  assert.ok(Math.abs(r.dollars - (5 + 0.5 + 6.25 + 25)) < 1e-9);
});

test("prices GPT-5.6 Sol, Terra, and Luna at their distinct API-equivalent rates", () => {
  const buckets = {
    inputTokens: 1_000_000, cachedReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000, outputTokens: 1_000_000
  };
  const cases = [
    ["gpt-5.6", "gpt-5.6-sol", 29.4],
    ["gpt-5.6-terra", "gpt-5.6-terra", 16.7],
    ["gpt-5.6-luna", "gpt-5.6-luna", 1.67]
  ];

  for (const [model, rateKey, dollars] of cases) {
    const result = priceRecord("codex", model, buckets);
    assert.equal(result.modelKnown, true);
    assert.equal(result.rateKey, rateKey);
    assert.ok(Math.abs(result.dollars - dollars) < 1e-9);
  }
});

test("prices GPT-5.4 mini separately from the full model", () => {
  const r = priceRecord("codex", "gpt-5.4-mini", {
    inputTokens: 1_000_000, cachedReadTokens: 1_000_000,
    cacheWriteTokens: 0, outputTokens: 1_000_000
  });
  assert.equal(r.rateKey, "gpt-5.4-mini");
  assert.ok(Math.abs(r.dollars - 5.325) < 1e-9);
});

test("uses Claude Sonnet 5 permanent launch pricing", () => {
  const buckets = {
    inputTokens: 1_000_000, cachedReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000, outputTokens: 1_000_000
  };
  const intro = priceRecord("claude", "claude-sonnet-5", buckets, "2026-07-25");
  const standard = priceRecord("claude", "claude-sonnet-5", buckets, "2026-09-01");
  assert.equal(intro.rateKey, "claude-sonnet-5");
  assert.ok(Math.abs(intro.dollars - 14.7) < 1e-9);
  assert.equal(standard.rateKey, "claude-sonnet-5");
  assert.ok(Math.abs(standard.dollars - 14.7) < 1e-9);
});

test("prices one-hour Claude cache writes at twice the input rate", () => {
  const result = priceRecord("claude", "claude-sonnet-5", {
    inputTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 1_000_000,
    cacheWrite1hTokens: 1_000_000,
    outputTokens: 0
  });
  assert.ok(Math.abs(result.dollars - 4) < 1e-9);
});

test("applies GPT-5.6 long-context multipliers to the full request", () => {
  const result = priceRecord("codex", "gpt-5.6-terra", {
    inputTokens: 300_000,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10_000,
    longContextInputTokens: 300_000,
    longContextOutputTokens: 10_000
  }, "2026-08-30");
  assert.ok(Math.abs(result.dollars - 1.38) < 1e-9);
});

test("unknown model remains unpriced instead of receiving a fallback", () => {
  const r = priceRecord("codex", "mystery", { inputTokens: 1_000_000, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  assert.equal(r.modelKnown, false);
  assert.equal(r.dollars, null);
});
