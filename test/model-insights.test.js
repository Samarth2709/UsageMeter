const test = require("node:test");
const assert = require("node:assert/strict");
const { buildModelInsights } = require("../usage-history/model-insights");

const model = (overrides = {}) => ({
  cli: "codex",
  model: "gpt-5.5-codex",
  rateKey: "gpt-5.5",
  dollars: 35,
  cacheSavings: 4.5,
  tokens: { input: 1_000_000, cachedRead: 0, cacheWrite: 0, output: 1_000_000 },
  ...overrides
});

test("buildModelInsights identifies the top model and same-token rate savings", () => {
  const insights = buildModelInsights([model(), model({ model: "gpt-5.4", rateKey: "gpt-5.4", dollars: 5, cacheSavings: 1 })]);
  assert.equal(insights.topModel.model, "gpt-5.5-codex");
  assert.equal(insights.topModel.share, 35 / 40);
  assert.equal(insights.totalCacheSavings, 5.5);
  assert.equal(insights.scenarios.length, 1);
  assert.equal(insights.scenarios[0].targetLabel, "GPT-5.4");
  assert.equal(insights.scenarios[0].scenarioDollars, 17.5);
  assert.equal(insights.scenarios[0].savings, 17.5);
});

test("buildModelInsights omits unknown and non-saving scenario rows", () => {
  const insights = buildModelInsights([
    model({ model: "mystery", rateKey: null, dollars: 4 }),
    model({ model: "gpt-5.4", rateKey: "gpt-5.4", dollars: 4 })
  ]);
  assert.deepEqual(insights.scenarios, []);
});
