const fs = require("node:fs");
const { localDay } = require("./day");
const { parseClaudeTranscript } = require("./parseClaude");
const { parseCodexTranscript } = require("./parseCodex");
const { priceRecord, cacheSavings, priceBreakdown } = require("./pricing");
const { listAllTranscriptFiles } = require("./sources");
const { loadCache, saveCache } = require("./store");

const EMPTY = () => ({ inputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, prompts: 0 });

function addBuckets(target, src) {
  target.inputTokens += src.inputTokens || 0;
  target.cachedReadTokens += src.cachedReadTokens || 0;
  target.cacheWriteTokens += src.cacheWriteTokens || 0;
  target.outputTokens += src.outputTokens || 0;
  target.prompts += src.prompts || 0;
  return target;
}

function recordsToContribution(records) {
  const contribution = {};
  for (const r of records) {
    const dayMap = (contribution[r.day] = contribution[r.day] || {});
    const key = `${r.cli}::${r.model}`;
    const bucket = dayMap[key] || EMPTY();
    addBuckets(bucket, r);
    bucket.prompts += 1; // each record is one model turn (one prompt)
    dayMap[key] = bucket;
  }
  return contribution;
}

function contributionForFile(filePath, text, cli) {
  // Select the parser by the CLI the file was discovered under — NOT by a path
  // substring. Codex sessions can live outside ~/.codex (e.g. a launcher's own
  // CODEX_HOME), so a "/.codex/" path check silently misparses them as Claude.
  const records = cli === "codex" ? parseCodexTranscript(text) : parseClaudeTranscript(text);
  return recordsToContribution(records);
}

function rangeDaysList(rangeDays, nowMs) {
  const days = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    days.push(localDay(nowMs - i * 86_400_000));
  }
  return days;
}

function bucketsWithTotal(b) {
  return {
    input: b.inputTokens, cachedRead: b.cachedReadTokens, cacheWrite: b.cacheWriteTokens,
    output: b.outputTokens, total: b.inputTokens + b.cachedReadTokens + b.cacheWriteTokens + b.outputTokens,
    prompts: b.prompts
  };
}

function perPrompt(dollars, prompts) {
  return prompts > 0 ? dollars / prompts : 0;
}

function mergeAndPrice(files, { rangeDays, nowMs }) {
  const wantDays = new Set(rangeDaysList(rangeDays, nowMs));
  const todayKey = localDay(nowMs);
  const unknownModels = new Set();

  // dayKey -> "cli::model" -> buckets
  const byDay = {};
  for (const entry of Object.values(files)) {
    for (const [day, models] of Object.entries(entry.contribution || {})) {
      if (!wantDays.has(day)) continue;
      const into = (byDay[day] = byDay[day] || {});
      for (const [key, buckets] of Object.entries(models)) {
        into[key] = addBuckets(into[key] || EMPTY(), buckets);
      }
    }
  }

  const priceKey = (key, buckets) => {
    const [cli, ...rest] = key.split("::");
    const model = rest.join("::");
    const p = priceRecord(cli, model, buckets);
    if (!p.modelKnown) unknownModels.add(model);
    return { cli, model, ...p };
  };

  const dayRows = rangeDaysList(rangeDays, nowMs).map((day) => {
    const models = byDay[day] || {};
    const dayTotals = EMPTY();
    const byCli = { claude: { buckets: EMPTY(), dollars: 0 }, codex: { buckets: EMPTY(), dollars: 0 } };
    const perModel = {}; // "cli::model" -> { tokens, dollars } for the model-mix chart
    let dollars = 0;
    for (const [key, buckets] of Object.entries(models)) {
      const priced = priceKey(key, buckets);
      addBuckets(dayTotals, buckets);
      dollars += priced.dollars;
      if (byCli[priced.cli]) { addBuckets(byCli[priced.cli].buckets, buckets); byCli[priced.cli].dollars += priced.dollars; }
      perModel[key] = { tokens: buckets.inputTokens + buckets.cachedReadTokens + buckets.cacheWriteTokens + buckets.outputTokens, dollars: priced.dollars };
    }
    return {
      day, tokens: bucketsWithTotal(dayTotals), dollars,
      byCli: { claude: { tokens: bucketsWithTotal(byCli.claude.buckets), dollars: byCli.claude.dollars },
               codex: { tokens: bucketsWithTotal(byCli.codex.buckets), dollars: byCli.codex.dollars } },
      models: perModel
    };
  });

  // range model breakdown
  const modelAcc = {};
  const rangeTotals = EMPTY();
  let rangeDollars = 0;
  for (const day of rangeDaysList(rangeDays, nowMs)) {
    for (const [key, buckets] of Object.entries(byDay[day] || {})) {
      const priced = priceKey(key, buckets);
      addBuckets(rangeTotals, buckets);
      rangeDollars += priced.dollars;
      const m = (modelAcc[key] = modelAcc[key] || { cli: priced.cli, model: priced.model, buckets: EMPTY(), dollars: 0, modelKnown: priced.modelKnown });
      addBuckets(m.buckets, buckets); m.dollars += priced.dollars;
    }
  }
  const byModel = Object.values(modelAcc)
    .map((m) => ({
      cli: m.cli, model: m.model, tokens: bucketsWithTotal(m.buckets), dollars: m.dollars,
      prompts: m.buckets.prompts, costPerPrompt: perPrompt(m.dollars, m.buckets.prompts),
      cacheSavings: cacheSavings(m.cli, m.model, m.buckets.cachedReadTokens), modelKnown: m.modelKnown
    }))
    .sort((a, b) => b.dollars - a.dollars);

  const rangeCacheSavings = byModel.reduce((s, m) => s + m.cacheSavings, 0);

  // Dollars by token type across the range (for the Economics page).
  const costByType = { input: 0, cachedRead: 0, cacheWrite: 0, output: 0 };
  for (const m of Object.values(modelAcc)) {
    const b = priceBreakdown(m.cli, m.model, m.buckets);
    costByType.input += b.input;
    costByType.cachedRead += b.cachedRead;
    costByType.cacheWrite += b.cacheWrite;
    costByType.output += b.output;
  }

  const todayRow = dayRows.find((d) => d.day === todayKey) || {
    tokens: bucketsWithTotal(EMPTY()), dollars: 0,
    byCli: { claude: { tokens: bucketsWithTotal(EMPTY()), dollars: 0 }, codex: { tokens: bucketsWithTotal(EMPTY()), dollars: 0 } }
  };

  const rangeTotalsOut = bucketsWithTotal(rangeTotals);

  return {
    today: {
      tokens: todayRow.tokens, dollars: todayRow.dollars, byCli: todayRow.byCli,
      costPerPrompt: perPrompt(todayRow.dollars, todayRow.tokens.prompts)
    },
    range: {
      tokens: rangeTotalsOut, dollars: rangeDollars, days: dayRows, byModel,
      avgCostPerPrompt: perPrompt(rangeDollars, rangeTotalsOut.prompts),
      cacheSavings: rangeCacheSavings,
      costByType
    },
    flags: { unknownModels: Array.from(unknownModels) },
    scannedAt: new Date(nowMs).toISOString()
  };
}

function scanUsageHistory({ homeDir, dataDir, nowMs = Date.now(), rangeDays = 30 }) {
  const cache = loadCache(dataDir);
  const found = listAllTranscriptFiles(homeDir);
  const foundPaths = new Set(found.map((f) => f.path));

  // drop deleted files
  for (const p of Object.keys(cache.files)) {
    if (!foundPaths.has(p)) delete cache.files[p];
  }

  for (const { path: p, cli } of found) {
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    const cached = cache.files[p];
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
    let text = "";
    try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
    cache.files[p] = { mtimeMs: stat.mtimeMs, size: stat.size, cli, contribution: contributionForFile(p, text, cli) };
  }

  saveCache(dataDir, cache);
  return mergeAndPrice(cache.files, { rangeDays, nowMs });
}

module.exports = { recordsToContribution, contributionForFile, mergeAndPrice, scanUsageHistory };
