const test = require("node:test");
const assert = require("node:assert");
const { rateKeyForModel, priceRecord, FALLBACK } = require("../usage-history/pricing");

test("maps Claude/Codex model ids to rate keys", () => {
  assert.equal(rateKeyForModel("claude", "claude-fable-5"), "claude-fable");
  assert.equal(rateKeyForModel("claude", "claude-opus-4-8"), "claude-opus");
  assert.equal(rateKeyForModel("claude", "claude-sonnet-4-6"), "claude-sonnet");
  assert.equal(rateKeyForModel("claude", "claude-haiku-4-5"), "claude-haiku");
  assert.equal(rateKeyForModel("codex", "gpt-5.5-codex"), "gpt-5.5");
  assert.equal(rateKeyForModel("codex", "gpt-5.4"), "gpt-5.4");
  assert.equal(rateKeyForModel("codex", "gpt-5.6"), "gpt-5.6-sol");
  assert.equal(rateKeyForModel("codex", "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(rateKeyForModel("codex", "gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(rateKeyForModel("codex", "gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(rateKeyForModel("codex", "gpt-5.6-sol-pro"), null);
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
    cacheWriteTokens: 0, outputTokens: 1_000_000
  };
  const cases = [
    ["gpt-5.6", "gpt-5.6-sol", 35.5],
    ["gpt-5.6-terra", "gpt-5.6-terra", 17.75],
    ["gpt-5.6-luna", "gpt-5.6-luna", 7.1]
  ];

  for (const [model, rateKey, dollars] of cases) {
    const result = priceRecord("codex", model, buckets);
    assert.equal(result.modelKnown, true);
    assert.equal(result.rateKey, rateKey);
    assert.ok(Math.abs(result.dollars - dollars) < 1e-9);
  }
});

test("unknown model uses fallback and flags modelKnown=false", () => {
  const r = priceRecord("codex", "mystery", { inputTokens: 1_000_000, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  assert.equal(r.modelKnown, false);
  assert.ok(Math.abs(r.dollars - FALLBACK.input) < 1e-9);
});
