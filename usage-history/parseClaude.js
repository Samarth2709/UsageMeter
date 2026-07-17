const { localDay } = require("./day");
const path = require("node:path");

function structuralCwd(obj) {
  const cwd = typeof obj?.cwd === "string" ? obj.cwd : obj?.payload?.cwd;
  return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null;
}

function parseClaudeTranscript(text) {
  const records = [];
  const seen = new Set();
  let currentProjectPath = null;

  for (const rawLine of String(text || "").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    currentProjectPath = structuralCwd(obj) || currentProjectPath;
    if (obj.type !== "assistant") continue;

    const msg = obj.message || {};
    const usage = msg.usage;
    if (!usage) continue;

    // Skip synthetic/interrupted assistant messages (model "<synthetic>"): they
    // carry no real token usage and are not billable API calls.
    if (msg.model === "<synthetic>") continue;

    const id = msg.id || obj.requestId;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }

    const ts = Date.parse(obj.timestamp);
    if (!Number.isFinite(ts)) continue;

    const inputTokens = Number(usage.input_tokens) || 0;
    const cachedReadTokens = Number(usage.cache_read_input_tokens) || 0;
    const cacheWriteTokens = Number(usage.cache_creation_input_tokens) || 0;
    const outputTokens = Number(usage.output_tokens) || 0;
    if (inputTokens + cachedReadTokens + cacheWriteTokens + outputTokens === 0) continue;

    const record = {
      timestampMs: ts,
      day: localDay(ts),
      cli: "claude",
      model: msg.model || "unknown",
      inputTokens,
      cachedReadTokens,
      cacheWriteTokens,
      outputTokens,
      isSidechain: Boolean(obj.isSidechain)
    };
    if (currentProjectPath) record.projectPath = currentProjectPath;
    records.push(record);
  }

  return records;
}

module.exports = { parseClaudeTranscript };
