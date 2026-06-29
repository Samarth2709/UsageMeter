const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { _test } = require("../server");

const { normalizeConfig, normalizeScanRoots, serializeConfig } = _test;
const home = os.homedir();

test("normalizeConfig defaults scanRoots to empty arrays when absent", () => {
  const n = normalizeConfig({ identities: [] });
  assert.deepEqual(n.scanRoots, { claude: [], codex: [] });
});

test("normalizeScanRoots expands ~ to absolute paths", () => {
  const sr = normalizeScanRoots({ claude: ["~/logs/claude"], codex: ["~"] });
  assert.deepEqual(sr.claude, [path.join(home, "logs/claude")]);
  assert.deepEqual(sr.codex, [home]);
});

test("normalizeScanRoots dedupes repeated paths", () => {
  const sr = normalizeScanRoots({ claude: ["~/a", "~/a", "~/b"] });
  assert.deepEqual(sr.claude, [path.join(home, "a"), path.join(home, "b")]);
});

test("normalizeScanRoots trims whitespace and drops non-strings/empties", () => {
  const sr = normalizeScanRoots({ codex: ["  ~/c  ", "", 42, null, "~/d"] });
  assert.deepEqual(sr.codex, [path.join(home, "c"), path.join(home, "d")]);
});

test("normalizeScanRoots coerces a non-array value to an empty array", () => {
  const sr = normalizeScanRoots({ claude: "not-an-array", codex: undefined });
  assert.deepEqual(sr, { claude: [], codex: [] });
});

test("normalizeScanRoots ignores unknown CLI keys", () => {
  const sr = normalizeScanRoots({ claude: ["~/a"], gemini: ["~/x"] });
  assert.deepEqual(Object.keys(sr).sort(), ["claude", "codex"]);
  assert.deepEqual(sr.codex, []);
});

test("serializeConfig compacts absolute scanRoots back to ~", () => {
  const n = normalizeConfig({ identities: [], scanRoots: { claude: ["~/proj/x"], codex: [] } });
  const s = serializeConfig(n);
  assert.deepEqual(s.scanRoots.claude, ["~/proj/x"]);
});

test("normalize → serialize → normalize is stable for scanRoots", () => {
  const a = normalizeConfig({ identities: [], scanRoots: { claude: ["~/p"], codex: ["~/q"] } });
  const b = normalizeConfig(serializeConfig(a));
  assert.deepEqual(b.scanRoots, a.scanRoots);
});
