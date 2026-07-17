const { priceBucketsAtRate } = require("./pricing");

const SCENARIO_TARGETS = {
  "claude-fable": { rateKey: "claude-sonnet", label: "Claude Sonnet" },
  "claude-opus": { rateKey: "claude-sonnet", label: "Claude Sonnet" },
  "gpt-5.5": { rateKey: "gpt-5.4", label: "GPT-5.4" }
};

function modelBuckets(model) {
  return {
    inputTokens: model.tokens?.input || 0,
    cachedReadTokens: model.tokens?.cachedRead || 0,
    cacheWriteTokens: model.tokens?.cacheWrite || 0,
    outputTokens: model.tokens?.output || 0
  };
}

function buildModelInsights(byModel = []) {
  const totalDollars = byModel.reduce((sum, model) => sum + (Number(model.dollars) || 0), 0);
  const top = byModel[0] || null;
  const scenarios = [];

  for (const model of byModel) {
    const target = SCENARIO_TARGETS[model.rateKey];
    if (!target) continue;
    const scenarioDollars = priceBucketsAtRate(target.rateKey, modelBuckets(model));
    const currentDollars = Number(model.dollars) || 0;
    const savings = currentDollars - (Number(scenarioDollars) || 0);
    if (!(savings > 0)) continue;

    scenarios.push({
      cli: model.cli,
      model: model.model,
      targetRateKey: target.rateKey,
      targetLabel: target.label,
      currentDollars,
      scenarioDollars,
      savings
    });
  }

  return {
    topModel: top
      ? {
          cli: top.cli,
          model: top.model,
          dollars: top.dollars,
          share: totalDollars > 0 ? top.dollars / totalDollars : 0
        }
      : null,
    totalCacheSavings: byModel.reduce((sum, model) => sum + (Number(model.cacheSavings) || 0), 0),
    scenarios
  };
}

module.exports = { buildModelInsights, SCENARIO_TARGETS };
