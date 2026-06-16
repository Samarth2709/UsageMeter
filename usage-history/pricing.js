// USD per 1,000,000 tokens. Verify Claude rates against the claude-api skill and
// Codex rates against current OpenAI pricing when revisiting; this table is the
// single source of truth for pricing.
const RATES = {
  "claude-opus":   { input: 15.0, cachedRead: 1.5, cacheWrite: 18.75, output: 75.0 },
  "claude-sonnet": { input: 3.0,  cachedRead: 0.3, cacheWrite: 3.75,  output: 15.0 },
  "claude-haiku":  { input: 1.0,  cachedRead: 0.1, cacheWrite: 1.25,  output: 5.0 },
  "gpt-5.5":       { input: 5.0,  cachedRead: 0.5, cacheWrite: 0,     output: 30.0 },
  "gpt-5.4":       { input: 2.5,  cachedRead: 0.25, cacheWrite: 0,    output: 15.0 }
};
const FALLBACK = { input: 3.0, cachedRead: 0.3, cacheWrite: 3.75, output: 15.0 };

function rateKeyForModel(cli, model) {
  const m = String(model || "").toLowerCase();
  if (cli === "claude") {
    if (m.includes("opus")) return "claude-opus";
    if (m.includes("sonnet")) return "claude-sonnet";
    if (m.includes("haiku")) return "claude-haiku";
    return null;
  }
  if (m.includes("5.5")) return "gpt-5.5";
  if (m.includes("5.4")) return "gpt-5.4";
  return null;
}

function priceRecord(cli, model, buckets) {
  const key = rateKeyForModel(cli, model);
  const rate = key ? RATES[key] : FALLBACK;
  const per = (tokens, r) => ((Number(tokens) || 0) * r) / 1_000_000;
  const dollars =
    per(buckets.inputTokens, rate.input) +
    per(buckets.cachedReadTokens, rate.cachedRead) +
    per(buckets.cacheWriteTokens, rate.cacheWrite) +
    per(buckets.outputTokens, rate.output);
  return { dollars, rateKey: key, modelKnown: key !== null };
}

module.exports = { RATES, FALLBACK, rateKeyForModel, priceRecord };
