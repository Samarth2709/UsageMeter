const { localDay } = require("./day");
const path = require("node:path");
const { structuralSessionIdentity } = require("./session-identity");

function structuralCwd(obj) {
  const cwd = typeof obj?.cwd === "string" ? obj.cwd : obj?.payload?.cwd;
  return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null;
}

function parseClaudeTranscriptChunk(text, initialState = {}) {
  const records = [];
  const usageById = { ...(initialState.usageById || {}) };
  const uncountedUsageIds = new Set(initialState.uncountedUsageIds || []);
  for (const id of initialState.seenIds || []) {
    if (!(id in usageById)) usageById[id] = null;
  }
  let currentProjectPath = initialState.currentProjectPath || null;
  let sessionIdentity = initialState.sessionIdentity || null;

  for (const rawLine of String(text || "").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    currentProjectPath = structuralCwd(obj) || currentProjectPath;
    const structuralIdentity = structuralSessionIdentity("claude", obj);
    if (
      structuralIdentity
      && (
        !sessionIdentity
        || structuralIdentity.startsWith("agent-")
        || !sessionIdentity.startsWith("agent-")
      )
    ) {
      sessionIdentity = structuralIdentity;
    }
    if (obj.type !== "assistant") continue;

    const msg = obj.message || {};
    const usage = msg.usage;
    if (!usage) continue;

    // Skip synthetic/interrupted assistant messages (model "<synthetic>"): they
    // carry no real token usage and are not billable API calls.
    if (msg.model === "<synthetic>") continue;

    const ts = Date.parse(obj.timestamp);
    if (!Number.isFinite(ts)) continue;

    const currentUsage = {
      inputTokens: Number(usage.input_tokens) || 0,
      cachedReadTokens: Number(usage.cache_read_input_tokens) || 0,
      cacheWriteTokens: Number(usage.cache_creation_input_tokens) || 0,
      cacheWrite1hTokens: Number(
        usage.cache_creation?.ephemeral_1h_input_tokens
        || usage.cache_creation_1h_input_tokens
      ) || 0,
      outputTokens: Number(usage.output_tokens) || 0
    };
    const id = msg.id || obj.requestId;
    const previousUsage = id ? usageById[id] : undefined;
    const tokenUsage = previousUsage
      ? {
        inputTokens: currentUsage.inputTokens - previousUsage.inputTokens,
        cachedReadTokens: currentUsage.cachedReadTokens - previousUsage.cachedReadTokens,
        cacheWriteTokens: currentUsage.cacheWriteTokens - previousUsage.cacheWriteTokens,
        cacheWrite1hTokens: currentUsage.cacheWrite1hTokens - (previousUsage.cacheWrite1hTokens || 0),
        outputTokens: currentUsage.outputTokens - previousUsage.outputTokens
      }
      : currentUsage;
    if (id) usageById[id] = currentUsage;
    if (previousUsage === null) continue;
    if (!Object.values(tokenUsage).some((tokens) => tokens !== 0)) {
      if (id && previousUsage === undefined) uncountedUsageIds.add(id);
      continue;
    }

    const record = {
      timestampMs: ts,
      day: localDay(ts),
      cli: "claude",
      model: msg.model || "unknown",
      ...tokenUsage,
      ...(id ? { eventId: id } : {}),
      isSidechain: Boolean(obj.isSidechain)
    };
    if (previousUsage && !uncountedUsageIds.has(id)) record.isCorrection = true;
    if (id) uncountedUsageIds.delete(id);
    if (currentProjectPath) record.projectPath = currentProjectPath;
    records.push(record);
  }

  return {
    records,
    state: {
      currentProjectPath,
      usageById,
      uncountedUsageIds: [...uncountedUsageIds],
      ...(sessionIdentity ? { sessionIdentity } : {})
    }
  };
}

function parseClaudeTranscript(text) {
  return parseClaudeTranscriptChunk(text).records;
}

module.exports = { parseClaudeTranscript, parseClaudeTranscriptChunk };
