const test = require("node:test");
const assert = require("node:assert");
const { localDay } = require("../usage-history/day");

test("formats a timestamp as local YYYY-MM-DD", () => {
  const ms = new Date(2026, 5, 16, 13, 45, 0).getTime();
  assert.equal(localDay(ms), "2026-06-16");
});

test("uses local midnight boundary", () => {
  const justBeforeMidnight = new Date(2026, 5, 16, 23, 59, 59).getTime();
  const justAfterMidnight = new Date(2026, 5, 17, 0, 0, 1).getTime();
  assert.equal(localDay(justBeforeMidnight), "2026-06-16");
  assert.equal(localDay(justAfterMidnight), "2026-06-17");
});
