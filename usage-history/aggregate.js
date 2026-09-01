const { localDay } = require("./day");
const { parseClaudeTranscript } = require("./parseClaude");
const { parseCodexTranscript } = require("./parseCodex");
const { priceRecord, cacheSavings, priceBreakdown } = require("./pricing");
const { buildModelInsights } = require("./model-insights");
const {
  EMPTY,
  addBuckets,
  recordsToContribution,
  recordsToProjectContribution
} = require("./contributions");
const { updateUsageIndex } = require("./index");

function bucketTokens(buckets) {
  return (
    (buckets.inputTokens || 0) +
    (buckets.cachedReadTokens || 0) +
    (buckets.cacheWriteTokens || 0) +
    (buckets.outputTokens || 0)
  );
}

function pricingCoverage(pricedTokens, unpricedTokens, pricedCalls = 0, unpricedCalls = 0) {
  const totalTokens = pricedTokens + unpricedTokens;
  return {
    complete: unpricedTokens === 0,
    pricedTokens,
    unpricedTokens,
    pricedCalls,
    unpricedCalls,
    coverage: totalTokens > 0 ? pricedTokens / totalTokens : 1
  };
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
    calls: b.calls
  };
}

function perCall(dollars, calls) {
  return calls > 0 ? dollars / calls : 0;
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
  const unpricedModels = new Map();

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

  const priceKey = (key, buckets, day) => {
    const [cli, ...rest] = key.split("::");
    const model = rest.join("::");
    const p = priceRecord(cli, model, buckets, day);
    if (!p.modelKnown) unpricedModels.set(`${cli}::${model}`, { cli, model });
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
          pricedTokens: 0,
          unpricedTokens: 0,
          pricedCalls: 0,
          unpricedCalls: 0,
          models: {}
        });
        for (const [modelKey, buckets] of Object.entries(project.models || {})) {
          const priced = priceKey(modelKey, buckets, day);
          const tokens = bucketTokens(buckets);
          addBuckets(into.buckets, buckets);
          if (priced.modelKnown) {
            into.dollars += priced.dollars;
            into.pricedTokens += tokens;
            into.pricedCalls += buckets.calls || 0;
          } else {
            into.unpricedTokens += tokens;
            into.unpricedCalls += buckets.calls || 0;
          }
          const model = (into.models[modelKey] = into.models[modelKey] || {
            cli: priced.cli, model: priced.model, dollars: 0, modelKnown: priced.modelKnown, tokens: 0
          });
          model.tokens += tokens;
          if (priced.modelKnown) model.dollars += priced.dollars;
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
    let pricedTokens = 0;
    let unpricedTokens = 0;
    let pricedCalls = 0;
    let unpricedCalls = 0;
    for (const [key, buckets] of Object.entries(models)) {
      const priced = priceKey(key, buckets, day);
      const tokens = bucketTokens(buckets);
      addBuckets(dayTotals, buckets);
      if (priced.modelKnown) {
        dollars += priced.dollars;
        pricedTokens += tokens;
        pricedCalls += buckets.calls || 0;
      } else {
        unpricedTokens += tokens;
        unpricedCalls += buckets.calls || 0;
      }
      if (byCli[priced.cli]) {
        addBuckets(byCli[priced.cli].buckets, buckets);
        if (priced.modelKnown) byCli[priced.cli].dollars += priced.dollars;
      }
      perModel[key] = { tokens, dollars: priced.dollars };
    }
    return {
      day, tokens: bucketsWithTotal(dayTotals), dollars,
      pricing: pricingCoverage(pricedTokens, unpricedTokens, pricedCalls, unpricedCalls),
      byCli: { claude: { tokens: bucketsWithTotal(byCli.claude.buckets), dollars: byCli.claude.dollars },
               codex: { tokens: bucketsWithTotal(byCli.codex.buckets), dollars: byCli.codex.dollars } },
      models: perModel
    };
  });

  // range model breakdown
  const modelAcc = {};
  const rangeTotals = EMPTY();
  let rangeDollars = 0;
  let rangePricedTokens = 0;
  let rangeUnpricedTokens = 0;
  let rangePricedCalls = 0;
  let rangeUnpricedCalls = 0;
  for (const day of rangeDaysList(rangeDays, nowMs)) {
    for (const [key, buckets] of Object.entries(byDay[day] || {})) {
      const priced = priceKey(key, buckets, day);
      const tokens = bucketTokens(buckets);
      addBuckets(rangeTotals, buckets);
      if (priced.modelKnown) {
        rangeDollars += priced.dollars;
        rangePricedTokens += tokens;
        rangePricedCalls += buckets.calls || 0;
      } else {
        rangeUnpricedTokens += tokens;
        rangeUnpricedCalls += buckets.calls || 0;
      }
      const m = (modelAcc[key] = modelAcc[key] || {
        cli: priced.cli,
        model: priced.model,
        buckets: EMPTY(),
        dollars: 0,
        modelKnown: priced.modelKnown,
        rateKeys: new Set(),
        cacheSavings: 0,
        costByType: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0 }
      });
      addBuckets(m.buckets, buckets);
      if (priced.modelKnown) {
        m.dollars += priced.dollars;
        m.rateKeys.add(priced.rateKey);
        m.cacheSavings += cacheSavings(m.cli, m.model, buckets.cachedReadTokens, day);
        const breakdown = priceBreakdown(m.cli, m.model, buckets, day);
        for (const type of Object.keys(m.costByType)) m.costByType[type] += breakdown[type];
      }
    }
  }
  const rangePricing = pricingCoverage(
    rangePricedTokens,
    rangeUnpricedTokens,
    rangePricedCalls,
    rangeUnpricedCalls
  );
  const byModel = Object.values(modelAcc)
    .map((m) => {
      const costByType = m.modelKnown ? m.costByType : null;
      const costDriver = costByType
        ? Object.entries(costByType).sort(([, a], [, b]) => b - a)[0]?.[0] || null
        : null;
      return {
        cli: m.cli, model: m.model, tokens: bucketsWithTotal(m.buckets),
        dollars: m.modelKnown ? m.dollars : null,
        calls: m.buckets.calls,
        costPerCall: m.modelKnown ? perCall(m.dollars, m.buckets.calls) : null,
        cacheSavings: m.modelKnown ? m.cacheSavings : null,
        modelKnown: m.modelKnown,
        rateKey: m.rateKeys.size === 1 ? Array.from(m.rateKeys)[0] : null,
        costByType,
        costDriver
      };
    })
    .sort((a, b) => (Number(b.dollars) || 0) - (Number(a.dollars) || 0) || b.tokens.total - a.tokens.total);

  const rangeCacheSavings = byModel.reduce((s, m) => s + (Number(m.cacheSavings) || 0), 0);

  // Dollars by token type across the range (for the Economics page).
  const costByType = { input: 0, cachedRead: 0, cacheWrite: 0, output: 0 };
  for (const m of Object.values(modelAcc)) {
    if (!m.modelKnown) continue;
    costByType.input += m.costByType.input;
    costByType.cachedRead += m.costByType.cachedRead;
    costByType.cacheWrite += m.costByType.cacheWrite;
    costByType.output += m.costByType.output;
  }

  const todayRow = dayRows.find((d) => d.day === todayKey) || {
    tokens: bucketsWithTotal(EMPTY()), dollars: 0,
    pricing: pricingCoverage(0, 0),
    byCli: { claude: { tokens: bucketsWithTotal(EMPTY()), dollars: 0 }, codex: { tokens: bucketsWithTotal(EMPTY()), dollars: 0 } }
  };

  const rangeTotalsOut = bucketsWithTotal(rangeTotals);
  const byProject = Object.values(projectAcc)
    .map((project) => {
      const primaryModel = Object.values(project.models)
        .sort((a, b) => (Number(b.dollars) || 0) - (Number(a.dollars) || 0) || b.tokens - a.tokens)[0] || null;
      const pricing = pricingCoverage(
        project.pricedTokens,
        project.unpricedTokens,
        project.pricedCalls,
        project.unpricedCalls
      );
      return {
        key: project.key,
        label: project.label,
        parentLabel: project.parentLabel,
        path: project.path,
        tokens: bucketsWithTotal(project.buckets),
        dollars: project.dollars,
        calls: project.buckets.calls,
        pricing,
        share: rangePricing.complete && rangeDollars > 0 ? project.dollars / rangeDollars : null,
        primaryModel: primaryModel && { cli: primaryModel.cli, model: primaryModel.model }
      };
    })
    .sort((a, b) => b.dollars - a.dollars)
    .slice(0, 20);

  return {
    today: {
      tokens: todayRow.tokens, dollars: todayRow.dollars, byCli: todayRow.byCli,
      pricing: todayRow.pricing,
      costPerCall: todayRow.pricing.complete ? perCall(todayRow.dollars, todayRow.tokens.calls) : null
    },
    range: {
      tokens: rangeTotalsOut, dollars: rangeDollars, days: dayRows, byModel, byProject,
      pricing: rangePricing,
      avgCostPerCall: rangePricing.complete ? perCall(rangeDollars, rangeTotalsOut.calls) : null,
      cacheSavings: rangeCacheSavings,
      costByType,
      modelInsights: buildModelInsights(byModel)
    },
    flags: {
      unpricedModels: Array.from(unpricedModels.values()),
      unknownModels: Array.from(unpricedModels.values(), ({ model }) => model)
    },
    scannedAt: new Date(nowMs).toISOString()
  };
}

function scanUsageHistory({ homeDir, dataDir, nowMs = Date.now(), rangeDays = 30, extraRoots = {} }) {
  const { index } = updateUsageIndex({ homeDir, dataDir, nowMs, extraRoots });
  return mergeAndPrice(index.files, { rangeDays, nowMs });
}

module.exports = {
  recordsToContribution,
  recordsToProjectContribution,
  contributionForFile,
  mergeAndPrice,
  rangeDaysList,
  scanUsageHistory
};
