const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "usage-history.json";
// Bump whenever parser/aggregation logic changes so cached contributions from an
// older version are discarded and transcripts are re-parsed with the new logic.
const CACHE_VERSION = 3;

function freshCache() {
  return { version: CACHE_VERSION, files: {} };
}

function loadCache(dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, FILE_NAME), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.files !== "object") {
      return freshCache();
    }
    return parsed;
  } catch {
    return freshCache();
  }
}

function saveCache(dataDir, cache) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, FILE_NAME), JSON.stringify(cache));
}

module.exports = { loadCache, saveCache, freshCache, FILE_NAME, CACHE_VERSION };
