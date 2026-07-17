const fs = require("node:fs");
const path = require("node:path");
const { localDay } = require("./day");
const { parseClaudeTranscript } = require("./parseClaude");
const { parseCodexTranscript } = require("./parseCodex");
const { priceRecord, cacheSavings, priceBreakdown } = require("./pricing");
const { buildModelInsights } = require("./model-insights");
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

function projectForRecord(record, filePath, cli) {
  if (typeof record.projectPath === "string" && path.isAbsolute(record.projectPath)) {
    return {
      key: `path:${record.projectPath}`,
      path: record.projectPath,
      label: path.basename(record.projectPath) || record.projectPath,
      parentLabel: path.basename(path.dirname(record.projectPath)) || null
    };
  }

  if (cli === "claude") {
    const parts = filePath.split(path.sep);
    const projectsIndex = parts.lastIndexOf("projects");
    const folder = projectsIndex >= 0 ? parts[projectsIndex + 1] : null;
    if (folder) {
      return { key: `claude-folder:${folder}`, path: null, label: folder, parentLabel: null };
    }
  }

  return { key: "unattributed", path: null, label: "Unattributed", parentLabel: null };
}

function recordsToProjectContribution(records, filePath, cli) {
  const contribution = {};
  for (const record of records) {
    const project = projectForRecord(record, filePath, cli);
    const dayMap = (contribution[record.day] = contribution[record.day] || {});
    const entry = (dayMap[project.key] = dayMap[project.key] || { ...project, models: {} });
    const modelKey = `${record.cli}::${record.model}`;
    const bucket = entry.models[modelKey] || EMPTY();
    addBuckets(bucket, record);
    bucket.prompts += 1;
    entry.models[modelKey] = bucket;
  }
  return contribution;
}

function parseRecords(text, cli) {
  // Select the parser by the CLI the file was discovered under — NOT by a path
  // substring. Codex sessions can live outside ~/.codex (e.g. a launcher's own
  // CODEX_HOME), so a "/.codex/" path check silently misparses them as Claude.
  return cli === "codex" ? parseCodexTranscript(text) : parseClaudeTranscript(text);
}

function contributionForFile(filePath, text, cli) {
  return recordsToContribution(parseRecords(text, cli));
}

function rangeDaysList(rangeDays, nowMs) {
  const days = [];
  const today = new Date(nowMs);
  const localMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );

  for (let i = rangeDays - 1; i >= 0; i--) {
    const day = new Date(localMidnight);
    day.setDate(localMidnight.getDate() - i);
    days.push(localDay(day.getTime()));
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

function fallbackProjectContribution(entry) {
  const contribution = {};
  for (const [day, models] of Object.entries(entry.contribution || {})) {
    contribution[day] = {
      unattributed: { key: "unattributed", path: null, label: "Unattributed", parentLabel: null, models }
    };
  }
  return contribution;
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

  const projectAcc = {};
  for (const entry of Object.values(files)) {
    const contribution = entry.projectContribution || fallbackProjectContribution(entry);
    for (const [day, projects] of Object.entries(contribution)) {
      if (!wantDays.has(day)) continue;
      for (const [projectKey, project] of Object.entries(projects)) {
        const into = (projectAcc[projectKey] = projectAcc[projectKey] || {
          key: projectKey,
          path: project.path || null,
          label: project.label || "Unattributed",
          parentLabel: project.parentLabel || null,
          buckets: EMPTY(),
          dollars: 0,
          models: {}
        });
        for (const [modelKey, buckets] of Object.entries(project.models || {})) {
          const priced = priceKey(modelKey, buckets);
          addBuckets(into.buckets, buckets);
          into.dollars += priced.dollars;
          const model = (into.models[modelKey] = into.models[modelKey] || { cli: priced.cli, model: priced.model, dollars: 0 });
          model.dollars += priced.dollars;
        }
      }
    }
  }

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
    .map((m) => {
      const priced = priceRecord(m.cli, m.model, m.buckets);
      const costByType = priceBreakdown(m.cli, m.model, m.buckets);
      const costDriver = Object.entries(costByType).sort(([, a], [, b]) => b - a)[0]?.[0] || null;
      return {
        cli: m.cli, model: m.model, tokens: bucketsWithTotal(m.buckets), dollars: m.dollars,
        prompts: m.buckets.prompts, costPerPrompt: perPrompt(m.dollars, m.buckets.prompts),
        cacheSavings: cacheSavings(m.cli, m.model, m.buckets.cachedReadTokens),
        modelKnown: m.modelKnown, rateKey: priced.rateKey, costByType, costDriver
      };
    })
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
  const byProject = Object.values(projectAcc)
    .map((project) => {
      const primaryModel = Object.values(project.models).sort((a, b) => b.dollars - a.dollars)[0] || null;
      return {
        key: project.key,
        label: project.label,
        parentLabel: project.parentLabel,
        path: project.path,
        tokens: bucketsWithTotal(project.buckets),
        dollars: project.dollars,
        prompts: project.buckets.prompts,
        share: rangeDollars > 0 ? project.dollars / rangeDollars : 0,
        primaryModel: primaryModel && { cli: primaryModel.cli, model: primaryModel.model }
      };
    })
    .sort((a, b) => b.dollars - a.dollars);

  return {
    today: {
      tokens: todayRow.tokens, dollars: todayRow.dollars, byCli: todayRow.byCli,
      costPerPrompt: perPrompt(todayRow.dollars, todayRow.tokens.prompts)
    },
    range: {
      tokens: rangeTotalsOut, dollars: rangeDollars, days: dayRows, byModel, byProject,
      avgCostPerPrompt: perPrompt(rangeDollars, rangeTotalsOut.prompts),
      cacheSavings: rangeCacheSavings,
      costByType,
      modelInsights: buildModelInsights(byModel)
    },
    flags: { unknownModels: Array.from(unknownModels) },
    scannedAt: new Date(nowMs).toISOString()
  };
}

function scanUsageHistory({ homeDir, dataDir, nowMs = Date.now(), rangeDays = 30, extraRoots = {} }) {
  const cache = loadCache(dataDir);
  const found = listAllTranscriptFiles(homeDir, extraRoots);
  const foundPaths = new Set(found.map((f) => f.path));

  // drop deleted files
  for (const p of Object.keys(cache.files)) {
    if (!foundPaths.has(p)) delete cache.files[p];
  }

  for (const { path: p, cli } of found) {
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    const cached = cache.files[p];
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.cli === cli) continue;
    let text = "";
    try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
    const records = parseRecords(text, cli);
    cache.files[p] = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      cli,
      contribution: recordsToContribution(records),
      projectContribution: recordsToProjectContribution(records, p, cli)
    };
  }

  saveCache(dataDir, cache);
  return mergeAndPrice(cache.files, { rangeDays, nowMs });
}

module.exports = {
  recordsToContribution,
  recordsToProjectContribution,
  contributionForFile,
  mergeAndPrice,
  rangeDaysList,
  scanUsageHistory
};
