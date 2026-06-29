const fs = require("node:fs");
const { parseClaudeTranscript } = require("./parseClaude");
const { parseCodexTranscript } = require("./parseCodex");
const { priceRecord } = require("./pricing");
const { listAllTranscriptFiles } = require("./sources");
const { usageWindowKey } = require("../usage-windows");

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Read a little past a week so a session file straddling the weekly boundary isn't skipped.
const LOOKBACK_MS = WEEK_MS + 24 * 60 * 60 * 1000;
// Below this %, the projection (divide by pct) amplifies noise too much to be meaningful.
const MIN_PROJECT_PCT = 5;

function windowDurationMs(kind) {
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

// Parse only the transcripts touched within the lookback window into priced,
// timestamped points: { timestampMs, cli, dollars, tokens }. Bounded by mtime so a
// large history doesn't get fully re-parsed on every dashboard load. Each point is
// priced per token type (input/output/cache at their own rates), so a point's dollars
// already reflect its real input:output mix — no blended ratio is assumed here.
function recentPricedPoints(homeDir, nowMs, extraRoots = {}) {
  const cutoff = nowMs - LOOKBACK_MS;
  const points = [];
  for (const { path: filePath, cli } of listAllTranscriptFiles(homeDir, extraRoots)) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    let text = "";
    try { text = fs.readFileSync(filePath, "utf8"); } catch { continue; }
    const records = cli === "codex" ? parseCodexTranscript(text) : parseClaudeTranscript(text);
    for (const r of records) {
      points.push({ timestampMs: r.timestampMs, cli, dollars: priceRecord(cli, r.model, r).dollars, tokens: recordTokens(r) });
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
function computeWindowValues({ homeDir, nowMs = Date.now(), limits = [], extraRoots = {} } = {}) {
  const resolvable = limits
    .map((w) => ({ ...w, kind: usageWindowKey(w), durationMs: windowDurationMs(usageWindowKey(w)) }))
    .filter((w) => w.cli && w.durationMs && w.resetAt && Number.isFinite(Date.parse(w.resetAt)));
  if (!resolvable.length) return [];

  const points = recentPricedPoints(homeDir, nowMs, extraRoots);

  // Per-CLI blended $/token over the whole lookback baseline — the stable rate used
  // to value each window's unspent remainder.
  const baseline = {};
  for (const p of points) {
    const b = (baseline[p.cli] = baseline[p.cli] || { dollars: 0, tokens: 0 });
    b.dollars += p.dollars;
    b.tokens += p.tokens;
  }
  const blendedRate = (cli) => (baseline[cli] && baseline[cli].tokens > 0 ? baseline[cli].dollars / baseline[cli].tokens : 0);

  return resolvable.map((w) => {
    const resetMs = Date.parse(w.resetAt);
    const start = resetMs - w.durationMs;
    const end = Math.min(nowMs, resetMs);
    let usedDollars = 0;
    let usedTokens = 0;
    for (const p of points) {
      if (p.cli !== w.cli) continue;
      if (p.timestampMs >= start && p.timestampMs <= end) { usedDollars += p.dollars; usedTokens += p.tokens; }
    }
    const projected = projectFull(usedDollars, usedTokens, w.usedPercent, blendedRate(w.cli));
    return {
      cli: w.cli,
      kind: w.kind,
      label: w.label,
      usedPercent: Number(w.usedPercent) || 0,
      usedDollars,
      usedTokens,
      projectedDollars: projected.value,
      full: projected.full,
      resetAt: w.resetAt
    };
  });
}

module.exports = { computeWindowValues, projectFull, windowDurationMs, recentPricedPoints, transcriptFingerprint };
