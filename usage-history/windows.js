const fs = require("node:fs");
const { priceRecord } = require("./pricing");
const { listAllTranscriptFiles } = require("./sources");
const { usageWindowKey } = require("../usage-windows");
const { updateUsageIndex } = require("./index");

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Read a little past a week so a session file straddling the weekly boundary isn't skipped.
const LOOKBACK_MS = WEEK_MS + 24 * 60 * 60 * 1000;
// Below this %, the projection (divide by pct) amplifies noise too much to be meaningful.
const MIN_PROJECT_PCT = 5;

function windowDurationMs(windowOrKind) {
  if (typeof windowOrKind === "object" && windowOrKind !== null) {
    const reportedSeconds = Number(windowOrKind.durationSeconds);
    if (Number.isFinite(reportedSeconds) && reportedSeconds > 0) {
      return reportedSeconds * 1000;
    }
  }
  const kind = typeof windowOrKind === "string" ? windowOrKind : usageWindowKey(windowOrKind);
  if (kind === "fiveHour") return FIVE_HOUR_MS;
  if (kind === "week") return WEEK_MS;
  return null;
}

// A cheap signature of all transcript files (count + total size + newest mtime).
// If it's unchanged, no usage has been written, so a cached history payload is still
// current and an expensive recompute can be skipped.
function transcriptFingerprint(homeDir, extraRoots = {}) {
  let count = 0;
  let totalSize = 0;
  let maxMtime = 0;
  for (const { path: filePath } of listAllTranscriptFiles(homeDir, extraRoots)) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    count += 1;
    totalSize += stat.size;
    if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
  }
  return `${count}:${totalSize}:${maxMtime}`;
}

let transientIndex = null;
let transientHomeDir = null;
let lastIndexStats = {
  appendedFiles: 0,
  rebuiltFiles: 0,
  bytesRead: 0
};

// Load compact minute buckets from the persisted index and price them on read so
// pricing-table changes do not require reparsing transcripts.
function recentPricedPoints(homeDir, nowMs, extraRoots = {}, dataDir = null, usageIndex = null) {
  const cutoff = nowMs - LOOKBACK_MS;
  const points = [];

  let index = usageIndex;
  if (!index) {
    if (!dataDir && transientHomeDir !== homeDir) {
      transientIndex = null;
      transientHomeDir = homeDir;
    }
    const updated = updateUsageIndex({
      homeDir,
      dataDir,
      nowMs,
      extraRoots,
      index: dataDir ? null : transientIndex
    });
    index = updated.index;
    lastIndexStats = updated.stats;
    if (!dataDir) transientIndex = index;
  } else {
    lastIndexStats = {
      appendedFiles: 0,
      rebuiltFiles: 0,
      bytesRead: 0
    };
  }

  const firstMinute = Math.floor(cutoff / 60000) * 60000;
  for (const entry of Object.values(index.files || {})) {
    for (const [minute, models] of Object.entries(entry.minuteContribution || {})) {
      const timestampMs = Number(minute);
      if (!Number.isFinite(timestampMs) || timestampMs < firstMinute || timestampMs > nowMs) continue;
      for (const [key, buckets] of Object.entries(models)) {
        const [cli, ...modelParts] = key.split("::");
        const model = modelParts.join("::");
        const priced = priceRecord(cli, model, buckets, timestampMs);
        const tokens = (
          (buckets.inputTokens || 0)
          + (buckets.cachedReadTokens || 0)
          + (buckets.cacheWriteTokens || 0)
          + (buckets.outputTokens || 0)
        );
      points.push({
          timestampMs,
        cli,
        dollars: priced.dollars,
          tokens,
        modelKnown: priced.modelKnown
      });
      }
    }
  }
  return points;
}

// Project the full-window value WITHOUT assuming the current window's exact token mix
// continues. The spent part is exact (usedDollars); the unspent part is estimated as
// the remaining tokens (scaled from usage so far by the limit %) valued at a stable
// blended $/token rate — the user's recent average mix, not a noisy snapshot. This
// keeps the projection ≥ what's already spent and dampens swings at low %.
function projectFull(usedDollars, usedTokens, usedPercent, blendedRate) {
  const pct = Math.min(Number(usedPercent) || 0, 100);
  if (pct >= 100) return { value: usedDollars, full: true };
  if (pct < MIN_PROJECT_PCT) return { value: null, full: false };
  const rate = blendedRate > 0 ? blendedRate : (usedTokens > 0 ? usedDollars / usedTokens : 0);
  const remainderTokens = (usedTokens * (100 - pct)) / pct;
  return { value: usedDollars + remainderTokens * rate, full: false };
}

// limits: [{ cli, label, usedPercent, resetAt }] from the live snapshot.
// Returns one row per resolvable window with the API-dollar value used in it.
function computeWindowValues({
  homeDir,
  nowMs = Date.now(),
  limits = [],
  extraRoots = {},
  dataDir = null,
  usageIndex = null,
  points: providedPoints = null
} = {}) {
  const resolvable = limits
    .map((w) => ({ ...w, kind: usageWindowKey(w), durationMs: windowDurationMs(w) }))
    .filter((w) => w.cli && w.durationMs && w.resetAt && Number.isFinite(Date.parse(w.resetAt)));
  if (!resolvable.length) return [];

  const points = providedPoints || recentPricedPoints(
    homeDir,
    nowMs,
    extraRoots,
    dataDir,
    usageIndex
  );

  // Per-CLI blended $/token over the whole lookback baseline — the stable rate used
  // to value each window's unspent remainder.
  const baseline = {};
  for (const p of points) {
    if (p.timestampMs > nowMs) continue;
    const b = (baseline[p.cli] = baseline[p.cli] || { dollars: 0, tokens: 0, unpricedTokens: 0 });
    if (p.modelKnown) {
      b.dollars += p.dollars;
      b.tokens += p.tokens;
    } else {
      b.unpricedTokens += p.tokens;
    }
  }
  const blendedRate = (cli) => (
    baseline[cli] && baseline[cli].tokens > 0 && baseline[cli].unpricedTokens === 0
      ? baseline[cli].dollars / baseline[cli].tokens
      : 0
  );

  return resolvable.map((w) => {
    const resetMs = Date.parse(w.resetAt);
    const start = resetMs - w.durationMs;
    // The index intentionally aggregates recent usage by minute. Include the
    // first partial minute so a turn exactly on the boundary is never dropped;
    // this can conservatively include at most 59.999 seconds before the window.
    const firstMinute = Math.floor(start / 60000) * 60000;
    const end = Math.min(nowMs, resetMs);
    let pricedDollars = 0;
    let usedTokens = 0;
    let unpricedTokens = 0;
    for (const p of points) {
      if (p.cli !== w.cli) continue;
      if (p.timestampMs >= firstMinute && p.timestampMs <= end) {
        usedTokens += p.tokens;
        if (p.modelKnown) pricedDollars += p.dollars;
        else unpricedTokens += p.tokens;
      }
    }
    const coverageComplete = w.durationMs <= LOOKBACK_MS;
    const pricingComplete = unpricedTokens === 0 && coverageComplete;
    const projected = pricingComplete && usedTokens > 0
      ? projectFull(pricedDollars, usedTokens, w.usedPercent, blendedRate(w.cli))
      : { value: null, full: false };
    return {
      cli: w.cli,
      kind: w.kind,
      label: w.label,
      usedPercent: Number(w.usedPercent) || 0,
      usedDollars: pricingComplete ? pricedDollars : null,
      pricedDollars,
      usedTokens,
      unpricedTokens,
      pricingComplete,
      coverageComplete,
      projectedDollars: projected.value,
      full: projected.full,
      resetAt: w.resetAt
    };
  });
}

module.exports = {
  computeWindowValues,
  projectFull,
  windowDurationMs,
  recentPricedPoints,
  transcriptFingerprint,
  clearPointsCache: () => {
    transientIndex = null;
    transientHomeDir = null;
  },
  _lastParseCount: () => (
    lastIndexStats.appendedFiles + lastIndexStats.rebuiltFiles
  ),
  _lastIndexStats: () => lastIndexStats
};
