const test = require("node:test");
const assert = require("node:assert/strict");

const { coerceResetAt, mergeUsageWindows } = require("../usage-windows");

test("usage window merge preserves existing reset metadata missing from incoming data", () => {
  const windows = mergeUsageWindows(
    [
      {
        label: "5-hour",
        usedPercent: 10,
        remainingPercent: 90,
        resetAt: "2026-05-04T22:00:00.000Z",
        source: "claude_cli"
      }
    ],
    [
      {
        label: "5-hour",
        usedPercent: 22,
        remainingPercent: 78,
        source: "claude_usage_api"
      },
      {
        label: "weekly",
        usedPercent: 55,
        remainingPercent: 45,
        resetAt: "2026-05-06T15:00:00.000Z",
        source: "claude_usage_api"
      }
    ]
  );

  assert.deepEqual(windows, [
    {
      label: "5-hour",
      usedPercent: 22,
      remainingPercent: 78,
      resetAt: "2026-05-04T22:00:00.000Z",
      resetText: null,
      resetAfterSeconds: undefined,
      source: "claude_usage_api"
    },
    {
      label: "weekly",
      usedPercent: 55,
      remainingPercent: 45,
      resetAt: "2026-05-06T15:00:00.000Z",
      source: "claude_usage_api"
    }
  ]);
});

test("Claude reset timestamps accept epoch seconds from usage APIs", () => {
  assert.equal(coerceResetAt(1777932000), "2026-05-04T22:00:00.000Z");
  assert.equal(coerceResetAt("1777932000"), "2026-05-04T22:00:00.000Z");
});
