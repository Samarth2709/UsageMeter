// USD per 1,000,000 tokens. Claude rates verified against the claude-api skill
// (Models table, 2026-06): Fable 5 $10/$50, Opus 4.x $5/$25, Sonnet 4.6 $3/$15,
// Haiku 4.5 $1/$5. Cache read = 0.1x input; cache write = 1.25x input (5-minute
// ephemeral default). Codex/OpenAI rates from current OpenAI pricing (gpt-5.5
// $5/$30, gpt-5.4 $2.50/$15; cached input 0.1x; Codex has no cache-write bucket).
// This table is the single source of truth for pricing.
const RATES = {
  "claude-fable":  { input: 10.0, cachedRead: 1.0,  cacheWrite: 12.5,  output: 50.0 },
  "claude-opus":   { input: 5.0,  cachedRead: 0.5,  cacheWrite: 6.25,  output: 25.0 },
  "claude-sonnet": { input: 3.0,  cachedRead: 0.3,  cacheWrite: 3.75,  output: 15.0 },
  "claude-haiku":  { input: 1.0,  cachedRead: 0.1,  cacheWrite: 1.25,  output: 5.0 },
  "gpt-5.5":       { input: 5.0,  cachedRead: 0.5,  cacheWrite: 0,     output: 30.0 },
  "gpt-5.4":       { input: 2.5,  cachedRead: 0.25, cacheWrite: 0,     output: 15.0 }
};
const FALLBACK = { input: 3.0, cachedRead: 0.3, cacheWrite: 3.75, output: 15.0 };

function rateKeyForModel(cli, model) {
  const m = String(model || "").toLowerCase();
  if (cli === "claude") {
    if (m.includes("fable") || m.includes("mythos")) return "claude-fable";
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
