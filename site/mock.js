// Realistic but fake usage data for the website demo. Everything is derived from
// per-day, per-model token buckets so totals always reconcile (days sum to range,
// byModel sums to range, etc.) — the same way the real app aggregates.
(function () {
  const RATES = {
    "claude-fable": { input: 10.0, cachedRead: 1.0, cacheWrite: 12.5, output: 50.0 },
    "claude-opus": { input: 5.0, cachedRead: 0.5, cacheWrite: 6.25, output: 25.0 },
    "claude-sonnet": { input: 3.0, cachedRead: 0.3, cacheWrite: 3.75, output: 15.0 },
    "claude-haiku": { input: 1.0, cachedRead: 0.1, cacheWrite: 1.25, output: 5.0 },
    "gpt-5.5": { input: 5.0, cachedRead: 0.5, cacheWrite: 0, output: 30.0 },
    "gpt-5.4": { input: 2.5, cachedRead: 0.25, cacheWrite: 0, output: 15.0 }
  };
  const MODELS = [
    { cli: "codex", model: "gpt-5.5", rate: "gpt-5.5", weight: 0.6, project: ["path:/Users/you/Projects/usage-meter", "usage-meter", "Projects", "/Users/you/Projects/usage-meter"] },
    { cli: "codex", model: "gpt-5.4", rate: "gpt-5.4", weight: 0.09, project: ["path:/Users/you/Projects/kernel", "kernel", "Projects", "/Users/you/Projects/kernel"] },
    { cli: "claude", model: "claude-opus-4-8", rate: "claude-opus", weight: 0.17, project: ["path:/Users/you/Projects/fixreview", "fixreview", "Projects", "/Users/you/Projects/fixreview"] },
    { cli: "claude", model: "claude-fable-5", rate: "claude-fable", weight: 0.1, project: ["path:/Users/you/Projects/usage-meter", "usage-meter", "Projects", "/Users/you/Projects/usage-meter"] },
    { cli: "claude", model: "claude-haiku-4-5", rate: "claude-haiku", weight: 0.04, project: ["unattributed", "Unattributed", null, null] }
  ];

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  const localDay = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const emptyBuckets = () => ({ inputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, calls: 0 });
  function add(t, s) {
    t.inputTokens += s.inputTokens; t.cachedReadTokens += s.cachedReadTokens;
    t.cacheWriteTokens += s.cacheWriteTokens; t.outputTokens += s.outputTokens; t.calls += s.calls;
    return t;
  }
  const withTotal = (b) => ({
    input: b.inputTokens, cachedRead: b.cachedReadTokens, cacheWrite: b.cacheWriteTokens,
    output: b.outputTokens, total: b.inputTokens + b.cachedReadTokens + b.cacheWriteTokens + b.outputTokens, calls: b.calls
  });
  const completePricing = (b) => ({
    complete: true,
    pricedTokens: withTotal(b).total,
    unpricedTokens: 0,
    pricedCalls: b.calls,
    unpricedCalls: 0,
    coverage: 1
  });
  function priceOf(rate, b) {
    const r = RATES[rate];
    return (b.inputTokens * r.input + b.cachedReadTokens * r.cachedRead + b.cacheWriteTokens * r.cacheWrite + b.outputTokens * r.output) / 1e6;
  }
  const perCall = (d, p) => (p > 0 ? d / p : 0);

  function makeData(rangeDays) {
    const now = Date.now();
    const days = [];
    const modelAcc = {}; // rate-keyed accumulators across the range
    for (const m of MODELS) modelAcc[`${m.cli}::${m.model}`] = { cli: m.cli, model: m.model, rate: m.rate, project: m.project, b: emptyBuckets() };

    for (let i = rangeDays - 1; i >= 0; i--) {
      const dayMs = now - i * 86400000;
      const date = new Date(dayMs);
      const dow = date.getDay();
      const rnd = mulberry32(rangeDays * 7919 + i * 31 + 5);

      // daily intensity: weekend dip, occasional idle day, occasional spike
      let intensity = 0.45 + rnd() * 0.8;
      if (dow === 0 || dow === 6) intensity *= 0.5;
      if (rnd() < 0.12) intensity *= 0.08;        // idle day
      if (rnd() < 0.1) intensity *= 2.2;          // spike day

      const dayTotals = emptyBuckets();
      const byCli = { claude: { b: emptyBuckets(), dollars: 0 }, codex: { b: emptyBuckets(), dollars: 0 } };
      const models = {};
      let dayDollars = 0;

      for (let mi = 0; mi < MODELS.length; mi++) {
        const m = MODELS[mi];
        const r2 = mulberry32(rangeDays * 104729 + i * 97 + mi * 13 + 1);
        const calls = Math.round(intensity * m.weight * 2200 * (0.6 + r2() * 0.9));
        if (calls <= 0) continue;

        const b = {
          calls,
          outputTokens: Math.round(calls * (400 + r2() * 700)),
          inputTokens: Math.round(calls * (4000 + r2() * 5000)),       // fresh (uncached) input
          cachedReadTokens: Math.round(calls * (70000 + r2() * 55000)), // cache-heavy
          cacheWriteTokens: m.cli === "claude" ? Math.round(calls * (2500 + r2() * 4000)) : 0
        };
        const dollars = priceOf(m.rate, b);
        const key = `${m.cli}::${m.model}`;
        models[key] = { tokens: b.inputTokens + b.cachedReadTokens + b.cacheWriteTokens + b.outputTokens, dollars };
        add(dayTotals, b);
        add(byCli[m.cli].b, b);
        byCli[m.cli].dollars += dollars;
        dayDollars += dollars;
        add(modelAcc[key].b, b);
      }

      days.push({
        day: localDay(dayMs),
        tokens: withTotal(dayTotals),
        dollars: dayDollars,
        pricing: completePricing(dayTotals),
        byCli: {
          claude: { tokens: withTotal(byCli.claude.b), dollars: byCli.claude.dollars },
          codex: { tokens: withTotal(byCli.codex.b), dollars: byCli.codex.dollars }
        },
        models
      });
    }

    // range rollups
    const rangeB = emptyBuckets();
    let rangeDollars = 0;
    const costByType = { input: 0, cachedRead: 0, cacheWrite: 0, output: 0 };
    let cacheSavings = 0;
    const byModel = [];
    for (const acc of Object.values(modelAcc)) {
      if (acc.b.calls === 0) continue;
      const dollars = priceOf(acc.rate, acc.b);
      add(rangeB, acc.b);
      rangeDollars += dollars;
      const r = RATES[acc.rate];
      costByType.input += (acc.b.inputTokens * r.input) / 1e6;
      costByType.cachedRead += (acc.b.cachedReadTokens * r.cachedRead) / 1e6;
      costByType.cacheWrite += (acc.b.cacheWriteTokens * r.cacheWrite) / 1e6;
      costByType.output += (acc.b.outputTokens * r.output) / 1e6;
      const save = (acc.b.cachedReadTokens * (r.input - r.cachedRead)) / 1e6;
      cacheSavings += save;
      const modelCostByType = {
        input: (acc.b.inputTokens * r.input) / 1e6,
        cachedRead: (acc.b.cachedReadTokens * r.cachedRead) / 1e6,
        cacheWrite: (acc.b.cacheWriteTokens * r.cacheWrite) / 1e6,
        output: (acc.b.outputTokens * r.output) / 1e6
      };
      const costDriver = Object.entries(modelCostByType).sort((a, b) => b[1] - a[1])[0][0];
      byModel.push({
        cli: acc.cli, model: acc.model, tokens: withTotal(acc.b), dollars,
        calls: acc.b.calls, costPerCall: perCall(dollars, acc.b.calls),
        cacheSavings: save, modelKnown: true, rateKey: acc.rate, costByType: modelCostByType, costDriver
      });
    }
    byModel.sort((a, b) => b.dollars - a.dollars);

    const projectAcc = {};
    for (const acc of Object.values(modelAcc)) {
      if (!acc.b.calls) continue;
      const [key, label, parentLabel, projectPath] = acc.project;
      const project = projectAcc[key] || (projectAcc[key] = {
        key, label, parentLabel, path: projectPath, buckets: emptyBuckets(), dollars: 0, models: {}
      });
      const dollars = priceOf(acc.rate, acc.b);
      add(project.buckets, acc.b);
      project.dollars += dollars;
      const modelKey = `${acc.cli}::${acc.model}`;
      project.models[modelKey] = { cli: acc.cli, model: acc.model, dollars };
    }
    const byProject = Object.values(projectAcc).map((project) => {
      const primaryModel = Object.values(project.models).sort((a, b) => b.dollars - a.dollars)[0];
      return {
        key: project.key, label: project.label, parentLabel: project.parentLabel, path: project.path,
        tokens: withTotal(project.buckets), dollars: project.dollars, calls: project.buckets.calls,
        pricing: completePricing(project.buckets),
        share: rangeDollars > 0 ? project.dollars / rangeDollars : 0,
        primaryModel: primaryModel && { cli: primaryModel.cli, model: primaryModel.model }
      };
    }).sort((a, b) => b.dollars - a.dollars);

    const scenarioTargets = {
      "claude-fable": ["claude-sonnet", "Claude Sonnet"],
      "claude-opus": ["claude-sonnet", "Claude Sonnet"],
      "gpt-5.5": ["gpt-5.4", "GPT-5.4"]
    };
    const scenarios = byModel.flatMap((model) => {
      const target = scenarioTargets[model.rateKey];
      if (!target) return [];
      const source = modelAcc[`${model.cli}::${model.model}`];
      const scenarioDollars = priceOf(target[0], source.b);
      const savings = model.dollars - scenarioDollars;
      return savings > 0 ? [{
        cli: model.cli, model: model.model, targetRateKey: target[0], targetLabel: target[1],
        currentDollars: model.dollars, scenarioDollars, savings
      }] : [];
    });

    const last = days[days.length - 1];
    const today = {
      tokens: last.tokens, dollars: last.dollars, byCli: last.byCli,
      pricing: last.pricing,
      costPerCall: perCall(last.dollars, last.tokens.calls)
    };

    return {
      today,
      range: {
        tokens: withTotal(rangeB), dollars: rangeDollars, days, byModel, byProject,
        pricing: completePricing(rangeB),
        avgCostPerCall: perCall(rangeDollars, rangeB.calls),
        cacheSavings, costByType,
        modelInsights: {
          topModel: byModel[0] && { cli: byModel[0].cli, model: byModel[0].model, dollars: byModel[0].dollars, share: byModel[0].dollars / rangeDollars },
          totalCacheSavings: cacheSavings,
          scenarios
        }
      },
      flags: { unknownModels: [], unpricedModels: [] },
      scannedAt: new Date(now).toISOString(),
      windowValues: [
        { cli: "claude", kind: "fiveHour", label: "5-hour", usedPercent: 102, usedDollars: 9.8, pricedDollars: 9.8, unpricedTokens: 0, pricingComplete: true, projectedDollars: 9.8, full: true, resetAt: new Date(now + 1.3 * 3600e3).toISOString() },
        { cli: "claude", kind: "week", label: "weekly", usedPercent: 35, usedDollars: 120, pricedDollars: 120, unpricedTokens: 0, pricingComplete: true, projectedDollars: 342.86, full: false, resetAt: new Date(now + 4 * 86400e3).toISOString() },
        { cli: "codex", kind: "fiveHour", label: "5-hour", usedPercent: 100, usedDollars: 4.2, pricedDollars: 4.2, unpricedTokens: 0, pricingComplete: true, projectedDollars: 4.2, full: true, resetAt: new Date(now + 2 * 3600e3).toISOString() },
        { cli: "codex", kind: "week", label: "weekly", usedPercent: 40, usedDollars: 52, pricedDollars: 52, unpricedTokens: 0, pricingComplete: true, projectedDollars: 130, full: false, resetAt: new Date(now + 1.6 * 86400e3).toISOString() }
      ],
      appVersion: "0.2.5",
      diagnostics: {
        homeDir: "/Users/you",
        env: { CLAUDE_CONFIG_DIR: null, CODEX_HOME: null },
        cache: { path: "/Users/you/.rate-limit-tool/usage-history.json", version: 7 },
        claude: { dir: "/Users/you/.claude/projects", exists: true, readable: true, files: 218 },
        configuredClaude: [],
        codex: [
          { root: "/Users/you/.codex", exists: true, readable: true, sessionsFiles: 642, configured: false },
          { root: "/Users/you/Library/Application Support/orca/codex-runtime-home/home", exists: false, readable: true, sessionsFiles: 0, configured: false }
        ],
        configured: { claude: [], codex: [] },
        totals: { claudeFiles: 218, codexFiles: 642 }
      }
    };
  }

  // The demo dashboard talks to this exactly like the real app's IPC bridge.
  window.rateLimitAPI = {
    getUsageHistory: async (options = {}) => {
      const rangeDays = [7, 30, 90].includes(Number(options.rangeDays)) ? Number(options.rangeDays) : 30;
      return makeData(rangeDays);
    }
  };
})();
