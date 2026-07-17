const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "usage-history.json";
// Bump whenever parser/aggregation logic changes so cached contributions from an
// older version are discarded and transcripts are re-parsed with the new logic.
const CACHE_VERSION = 6;

function freshCache(version = CACHE_VERSION) {
  return { version, files: {} };
}

function loadCache(dataDir, fileName = FILE_NAME, version = CACHE_VERSION) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, fileName), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== version || typeof parsed.files !== "object") {
      return freshCache(version);
    }
    return parsed;
  } catch {
    return freshCache(version);
  }
}

function saveCache(dataDir, cache, fileName = FILE_NAME) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, fileName), JSON.stringify(cache));
}

module.exports = { loadCache, saveCache, freshCache, FILE_NAME, CACHE_VERSION };
