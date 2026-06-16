const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadCache, saveCache, CACHE_VERSION } = require("../usage-history/store");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "um-store-"));

test("returns a fresh cache when no file exists", () => {
  const cache = loadCache(tmpDir());
  assert.deepEqual(cache, { version: CACHE_VERSION, files: {} });
});

test("round-trips a saved cache", () => {
  const dir = tmpDir();
  const cache = { version: CACHE_VERSION, files: { "/a": { mtimeMs: 1, size: 2, cli: "claude", contribution: {} } } };
  saveCache(dir, cache);
  assert.deepEqual(loadCache(dir), cache);
});

test("returns a fresh cache when the file is corrupt", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "usage-history.json"), "{not json");
  assert.deepEqual(loadCache(dir), { version: CACHE_VERSION, files: {} });
});

test("discards a cache written by an older schema version", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "usage-history.json"), JSON.stringify({ version: 1, files: { "/old": {} } }));
  assert.deepEqual(loadCache(dir), { version: CACHE_VERSION, files: {} });
});
