const fs = require("node:fs");
const { parseClaudeTranscript } = require("./parseClaude");
const { parseCodexTranscript } = require("./parseCodex");
const { priceRecord } = require("./pricing");
const { listAllTranscriptFiles } = require("./sources");
const { usageWindowKey } = require("../usage-windows");
const { loadCache, saveCache } = require("./store");

// Disk cache for the recent-window points, mirroring scanUsageHistory's usage-history.json.
// Lets a fresh open (after the window closed and the in-memory map was freed) re-parse only
// the files whose mtime/size changed instead of all ~8 days of transcripts.
const POINTS_FILE = "window-points.json";
// Bump when the parser or cached record shape changes. Dollars are priced on read, so
// pricing-table changes take effect without a version bump.
const POINTS_VERSION = 3;

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

function recordTokens(r) {
  return (r.inputTokens || 0) + (r.cachedReadTokens || 0) + (r.cacheWriteTokens || 0) + (r.outputTokens || 0);
}

// Parse a transcript into compact raw records (unpriced) for the points cache. Dollars
// are computed on read in recentPricedPoints, so a pricing-table change applies to cached
// records without invalidating the cache.
function parseFileRecords(filePath, cli, cutoff) {
  let text = "";
  try { text = fs.readFileSync(filePath, "utf8"); } catch { return []; }
  const records = cli === "codex" ? parseCodexTranscript(text) : parseClaudeTranscript(text);
  return records
    .filter((r) => r.timestampMs >= cutoff)
    .map((r) => ({
      timestampMs: r.timestampMs,
      model: r.model,
      inputTokens: r.inputTokens || 0,
      cachedReadTokens: r.cachedReadTokens || 0,
      cacheWriteTokens: r.cacheWriteTokens || 0,
      outputTokens: r.outputTokens || 0
    }));
}

// Per-file cache of parsed records in the lookback window, keyed by
// path -> { mtimeMs, size, cli, records }.
// Reused across recomputes so only files whose (mtimeMs,size) actually changed get
// re-read+parsed — the same incremental strategy scanUsageHistory uses. Without this,
// every ~60s recompute re-parsed the entire recent window (~GB), spiking CPU/RSS.
// It's also persisted to disk (POINTS_FILE) so a fresh open after the window closed —
// when this map is emptied to keep idle RAM low — still only re-parses changed files
// instead of the whole ~8-day window (~3.5s → subsecond on a warm disk cache).
const pointsCache = new Map();
let lastParseCount = 0; // test seam: files (re)parsed on the most recent call

// Parse the transcripts touched within the lookback window into priced, timestamped
// points: { timestampMs, cli, dollars, tokens }. Each point is priced per token type
// (input/output/cache at their own rates), so a point's dollars reflect its real mix.
// When dataDir is given, the record cache is hydrated from / persisted to disk.
function recentPricedPoints(homeDir, nowMs, extraRoots = {}, dataDir = null) {
  const cutoff = nowMs - LOOKBACK_MS;
  const livePaths = new Set();
  const points = [];
  lastParseCount = 0;

  // Hydrate the in-memory map from disk once (when empty) so the first open after the
  // window closed doesn't re-parse everything — only (mtime,size)-changed files.
  if (dataDir && pointsCache.size === 0) {
    const disk = loadCache(dataDir, POINTS_FILE, POINTS_VERSION);
    for (const [p, e] of Object.entries(disk.files)) pointsCache.set(p, e);
  }

  let dirty = false;
  for (const { path: filePath, cli } of listAllTranscriptFiles(homeDir, extraRoots)) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    livePaths.add(filePath);

    let entry = pointsCache.get(filePath);
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size || entry.cli !== cli) {
      entry = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        cli,
        records: parseFileRecords(filePath, cli, cutoff)
      };
      pointsCache.set(filePath, entry);
      lastParseCount += 1;
      dirty = true;
    }

    const recentRecords = entry.records.filter((rec) => rec.timestampMs >= cutoff);
    if (recentRecords.length !== entry.records.length) {
      entry = { ...entry, records: recentRecords };
      pointsCache.set(filePath, entry);
      dirty = true;
    }
    for (const rec of recentRecords) {
      const priced = priceRecord(cli, rec.model, rec, rec.timestampMs);
      points.push({
        timestampMs: rec.timestampMs,
        cli,
        dollars: priced.dollars,
        tokens: recordTokens(rec),
        modelKnown: priced.modelKnown
      });
    }
  }

  // Evict files that dropped out of the recent window or were deleted, so the cache
  // stays bounded to the current lookback set.
  for (const key of pointsCache.keys()) {
    if (!livePaths.has(key)) { pointsCache.delete(key); dirty = true; }
  }

  // Persist only when the cache actually changed, so a no-op open doesn't rewrite the file.
  if (dataDir && dirty) {
    saveCache(dataDir, { version: POINTS_VERSION, files: Object.fromEntries(pointsCache) }, POINTS_FILE);
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
function computeWindowValues({ homeDir, nowMs = Date.now(), limits = [], extraRoots = {}, dataDir = null } = {}) {
  const resolvable = limits
    .map((w) => ({ ...w, kind: usageWindowKey(w), durationMs: windowDurationMs(w) }))
    .filter((w) => w.cli && w.durationMs && w.resetAt && Number.isFinite(Date.parse(w.resetAt)));
  if (!resolvable.length) return [];

  const points = recentPricedPoints(homeDir, nowMs, extraRoots, dataDir);

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
    const end = Math.min(nowMs, resetMs);
    let pricedDollars = 0;
    let usedTokens = 0;
    let unpricedTokens = 0;
    for (const p of points) {
      if (p.cli !== w.cli) continue;
      if (p.timestampMs >= start && p.timestampMs <= end) {
        usedTokens += p.tokens;
        if (p.modelKnown) pricedDollars += p.dollars;
        else unpricedTokens += p.tokens;
      }
    }
    const pricingComplete = unpricedTokens === 0;
    const projected = pricingComplete
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
  // Free the per-file points cache (e.g. when the history window closes) so it isn't
  // held resident while nobody is viewing history.
  clearPointsCache: () => pointsCache.clear(),
  // test seam: files (re)parsed on the most recent recentPricedPoints call
  _lastParseCount: () => lastParseCount
};
