const { localDay } = require("./day");
const path = require("node:path");
const { structuralSessionIdentity } = require("./session-identity");

function structuralCwd(obj) {
  const cwd = typeof obj?.cwd === "string" ? obj.cwd : obj?.payload?.cwd;
  return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null;
}

// Model name appears in session_meta / turn_context payloads (not in token_count).
function extractModel(obj) {
  const p = obj.payload || {};
  if ((obj.type === "session_meta" || obj.type === "turn_context") && typeof p.model === "string") {
    return p.model;
  }
  return null;
}

function parseCodexTranscriptChunk(text, initialState = {}) {
  const records = [];
  let currentModel = initialState.currentModel || null;
  let currentProjectPath = initialState.currentProjectPath || null;
  let lastTotalUsage = initialState.lastTotalUsage || null;
  let sessionIdentity = initialState.sessionIdentity || null;

  for (const rawLine of String(text || "").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    currentProjectPath = structuralCwd(obj) || currentProjectPath;
    sessionIdentity = structuralSessionIdentity("codex", obj) || sessionIdentity;

    const model = extractModel(obj);
    if (model) currentModel = model;

    const p = obj.payload || {};
    if (obj.type !== "event_msg" || p.type !== "token_count") continue;
    // Forked/subagent transcripts can replay inherited token_count events before
    // their first model-bearing turn_context. Those events are copied context,
    // not new usage in this file, and cannot be attributed safely.
    if (!currentModel) continue;

    const last = (p.info && p.info.last_token_usage) || null;
    const total = (p.info && p.info.total_token_usage) || null;
    const ts = Date.parse(obj.timestamp);
    if (!last || !Number.isFinite(ts)) continue;

    const hasTotalUsage = total && [
      "input_tokens",
      "cached_input_tokens",
      "cache_write_input_tokens",
      "output_tokens"
    ].some((key) => Number(total[key]) > 0);
    const totalUsage = hasTotalUsage ? {
      inputTokens: Number(total.input_tokens) || 0,
      cachedReadTokens: Number(total.cached_input_tokens) || 0,
      cacheWriteTokens: Number(total.cache_write_input_tokens) || 0,
      outputTokens: Number(total.output_tokens) || 0
    } : null;
    if (
      totalUsage
      && lastTotalUsage
      && Object.keys(totalUsage).every((key) => totalUsage[key] === lastTotalUsage[key])
    ) {
      continue;
    }
    if (totalUsage) lastTotalUsage = totalUsage;

    const input = Number(last.input_tokens) || 0;
    const cached = Number(last.cached_input_tokens) || 0;
    const cacheWrite = Number(last.cache_write_input_tokens) || 0;
    const output = Number(last.output_tokens) || 0;
    if (input + output === 0) continue;

    const record = {
      timestampMs: ts,
      day: localDay(ts),
      cli: "codex",
      model: currentModel,
      // Codex input_tokens includes both cache reads and cache writes.
      inputTokens: Math.max(0, input - cached - cacheWrite),
      cachedReadTokens: cached,
      cacheWriteTokens: cacheWrite,
      outputTokens: output
    };
    if (currentProjectPath) record.projectPath = currentProjectPath;
    records.push(record);
  }

  const state = { currentModel, currentProjectPath, lastTotalUsage };
  if (sessionIdentity) state.sessionIdentity = sessionIdentity;
  return { records, state };
}

function parseCodexTranscript(text) {
  return parseCodexTranscriptChunk(text).records;
}

module.exports = { parseCodexTranscript, parseCodexTranscriptChunk };
