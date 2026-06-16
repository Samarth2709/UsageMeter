const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "usage-history.json";

function freshCache() {
  return { version: 1, files: {} };
}

function loadCache(dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, FILE_NAME), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || typeof parsed.files !== "object") {
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

module.exports = { loadCache, saveCache, freshCache, FILE_NAME };
