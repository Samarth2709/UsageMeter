const { localDay } = require("./day");

function parseClaudeTranscript(text) {
  const records = [];
  const seen = new Set();

  for (const rawLine of String(text || "").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
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

    records.push({
      timestampMs: ts,
      day: localDay(ts),
      cli: "claude",
      model: msg.model || "unknown",
      inputTokens: Number(usage.input_tokens) || 0,
      cachedReadTokens: Number(usage.cache_read_input_tokens) || 0,
      cacheWriteTokens: Number(usage.cache_creation_input_tokens) || 0,
      outputTokens: Number(usage.output_tokens) || 0,
      isSidechain: Boolean(obj.isSidechain)
    });
  }

  return records;
}

module.exports = { parseClaudeTranscript };
