const test = require("node:test");
const assert = require("node:assert");
const { rateKeyForModel, priceRecord, FALLBACK } = require("../usage-history/pricing");

test("maps Claude/Codex model ids to rate keys", () => {
  assert.equal(rateKeyForModel("claude", "claude-opus-4-8"), "claude-opus");
  assert.equal(rateKeyForModel("claude", "claude-sonnet-4-6"), "claude-sonnet");
  assert.equal(rateKeyForModel("claude", "claude-haiku-4-5"), "claude-haiku");
  assert.equal(rateKeyForModel("codex", "gpt-5.5-codex"), "gpt-5.5");
  assert.equal(rateKeyForModel("codex", "gpt-5.4"), "gpt-5.4");
  assert.equal(rateKeyForModel("codex", "mystery-model"), null);
});

test("prices a known model by bucket", () => {
  const r = priceRecord("claude", "claude-opus-4-8", {
    inputTokens: 1_000_000, cachedReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000, outputTokens: 1_000_000
  });
  assert.equal(r.modelKnown, true);
  assert.equal(r.rateKey, "claude-opus");
  assert.ok(Math.abs(r.dollars - (15 + 1.5 + 18.75 + 75)) < 1e-9);
});

test("unknown model uses fallback and flags modelKnown=false", () => {
  const r = priceRecord("codex", "mystery", { inputTokens: 1_000_000, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  assert.equal(r.modelKnown, false);
  assert.ok(Math.abs(r.dollars - FALLBACK.input) < 1e-9);
});
