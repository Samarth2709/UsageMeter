// USD per 1,000,000 tokens. This catalog prices only model IDs whose published
// rate is known. New IDs still contribute tokens and calls, but remain unpriced
// until a rate is added instead of silently inheriting an unrelated fallback.
const RATES = {
  "claude-fable":           { input: 10.0, cachedRead: 1.0,   cacheWrite: 12.5,  output: 50.0 },
  "claude-opus":            { input: 5.0,  cachedRead: 0.5,   cacheWrite: 6.25,  output: 25.0 },
  "claude-sonnet-5":        { input: 2.0,  cachedRead: 0.2,   cacheWrite: 2.5,   cacheWrite1h: 4.0, output: 10.0 },
  "claude-sonnet":          { input: 3.0,  cachedRead: 0.3,   cacheWrite: 3.75,  output: 15.0 },
  "claude-haiku":           { input: 1.0,  cachedRead: 0.1,   cacheWrite: 1.25,  output: 5.0 },
  "gpt-5.6-sol-legacy":     { input: 5.0,  cachedRead: 0.5,   cacheWrite: 6.25,  output: 30.0 },
  "gpt-5.6-sol":            { input: 4.0,  cachedRead: 0.4,   cacheWrite: 5.0,   output: 20.0 },
  "gpt-5.6-terra-legacy":   { input: 2.5,  cachedRead: 0.25,  cacheWrite: 3.125, output: 15.0 },
  "gpt-5.6-terra":          { input: 2.0,  cachedRead: 0.2,   cacheWrite: 2.5,   output: 12.0 },
  "gpt-5.6-luna-legacy":    { input: 1.0,  cachedRead: 0.1,   cacheWrite: 1.25,  output: 6.0 },
  "gpt-5.6-luna":           { input: 0.2,  cachedRead: 0.02,  cacheWrite: 0.25,  output: 1.2 },
  "gpt-5.5":                { input: 5.0,  cachedRead: 0.5,   cacheWrite: 0,     output: 30.0 },
  "gpt-5.4":                { input: 2.5,  cachedRead: 0.25,  cacheWrite: 0,     output: 15.0 },
  "gpt-5.4-mini":           { input: 0.75, cachedRead: 0.075, cacheWrite: 0,     output: 4.5 }
};

function dayKey(at) {
  if (typeof at === "string" && /^\d{4}-\d{2}-\d{2}/.test(at)) return at.slice(0, 10);
  const timestamp = at == null ? Date.now() : Number(at);
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function rateKeyForModel(cli, model, at = null) {
  const m = String(model || "").toLowerCase();
  if (cli === "claude") {
    if (/^claude-(?:fable|mythos)-5(?:-\d{8})?$/.test(m)) return "claude-fable";
    if (/^claude-opus-(?:4-[5-8]|5)(?:-\d{8})?$/.test(m)) return "claude-opus";
    if (/^claude-sonnet-5(?:-\d{8})?$/.test(m)) {
      return "claude-sonnet-5";
    }
    if (/^claude-sonnet-4-[56](?:-\d{8})?$/.test(m)) return "claude-sonnet";
    if (/^claude-haiku-4-5(?:-\d{8})?$/.test(m)) return "claude-haiku";
    return null;
  }
  if (/^gpt-5\.6(?:-sol)?(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) {
    return dayKey(at) < "2026-08-21" ? "gpt-5.6-sol-legacy" : "gpt-5.6-sol";
  }
  if (/^gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) {
    return dayKey(at) < "2026-07-30" ? "gpt-5.6-terra-legacy" : "gpt-5.6-terra";
  }
  if (/^gpt-5\.6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) {
    return dayKey(at) < "2026-07-30" ? "gpt-5.6-luna-legacy" : "gpt-5.6-luna";
  }
  if (/^gpt-5\.5(?:-codex)?(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return "gpt-5.5";
  if (/^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return "gpt-5.4-mini";
  if (/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return "gpt-5.4";
  return null;
}

function priceAtRate(rate, buckets) {
  const per = (tokens, r) => ((Number(tokens) || 0) * r) / 1_000_000;
  const oneHourCacheWrite = Math.min(
    Number(buckets.cacheWriteTokens) || 0,
    Number(buckets.cacheWrite1hTokens) || 0
  );
  const fiveMinuteCacheWrite = Math.max(0, (Number(buckets.cacheWriteTokens) || 0) - oneHourCacheWrite);
  return (
    per(buckets.inputTokens, rate.input) +
    per(buckets.cachedReadTokens, rate.cachedRead) +
    per(fiveMinuteCacheWrite, rate.cacheWrite) +
    per(oneHourCacheWrite, rate.cacheWrite1h || rate.cacheWrite) +
    per(buckets.outputTokens, rate.output) +
    per(buckets.longContextInputTokens, rate.input) +
    per(buckets.longContextCachedReadTokens, rate.cachedRead) +
    per(buckets.longContextCacheWriteTokens, rate.cacheWrite) +
    per(buckets.longContextOutputTokens, rate.output * 0.5)
  );
}

function priceRecord(cli, model, buckets, at = null) {
  const key = rateKeyForModel(cli, model, at);
  if (!key) return { dollars: null, rateKey: null, modelKnown: false };
  const rate = RATES[key];
  const dollars = priceAtRate(rate, buckets);
  return { dollars, rateKey: key, modelKnown: true };
}

function priceBucketsAtRate(rateKey, buckets) {
  const rate = RATES[rateKey];
  return rate ? priceAtRate(rate, buckets) : null;
}

// Dollars saved by cache reads vs paying the full input rate for the same tokens.
function cacheSavings(cli, model, cachedReadTokens, at = null) {
  const key = rateKeyForModel(cli, model, at);
  if (!key) return null;
  const rate = RATES[key];
  return ((Number(cachedReadTokens) || 0) * (rate.input - rate.cachedRead)) / 1_000_000;
}

// Dollars attributable to each token type, for spend-by-type breakdowns.
function priceBreakdown(cli, model, buckets, at = null) {
  const key = rateKeyForModel(cli, model, at);
  if (!key) return null;
  const rate = RATES[key];
  const per = (tokens, r) => ((Number(tokens) || 0) * r) / 1_000_000;
  const oneHourCacheWrite = Math.min(
    Number(buckets.cacheWriteTokens) || 0,
    Number(buckets.cacheWrite1hTokens) || 0
  );
  const fiveMinuteCacheWrite = Math.max(0, (Number(buckets.cacheWriteTokens) || 0) - oneHourCacheWrite);
  return {
    input: per(buckets.inputTokens, rate.input) + per(buckets.longContextInputTokens, rate.input),
    cachedRead: per(buckets.cachedReadTokens, rate.cachedRead) + per(buckets.longContextCachedReadTokens, rate.cachedRead),
    cacheWrite: per(fiveMinuteCacheWrite, rate.cacheWrite)
      + per(oneHourCacheWrite, rate.cacheWrite1h || rate.cacheWrite)
      + per(buckets.longContextCacheWriteTokens, rate.cacheWrite),
    output: per(buckets.outputTokens, rate.output) + per(buckets.longContextOutputTokens, rate.output * 0.5)
  };
}

module.exports = { RATES, rateKeyForModel, priceRecord, priceBucketsAtRate, cacheSavings, priceBreakdown };
