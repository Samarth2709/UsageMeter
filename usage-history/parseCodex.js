const { localDay } = require("./day");
const path = require("node:path");

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

function parseCodexTranscript(text) {
  const records = [];
  let currentModel = "unknown";
  let currentProjectPath = null;

  for (const rawLine of String(text || "").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    currentProjectPath = structuralCwd(obj) || currentProjectPath;

    const model = extractModel(obj);
    if (model) currentModel = model;

    const p = obj.payload || {};
    if (obj.type !== "event_msg" || p.type !== "token_count") continue;

    const last = (p.info && p.info.last_token_usage) || null;
    const ts = Date.parse(obj.timestamp);
    if (!last || !Number.isFinite(ts)) continue;

    const input = Number(last.input_tokens) || 0;
    const cached = Number(last.cached_input_tokens) || 0;
    const output = Number(last.output_tokens) || 0;
    if (input + output === 0) continue;

    const record = {
      timestampMs: ts,
      day: localDay(ts),
      cli: "codex",
      model: currentModel,
      inputTokens: Math.max(0, input - cached), // codex input_tokens INCLUDES cached
      cachedReadTokens: cached,
      cacheWriteTokens: 0,
      outputTokens: output
    };
    if (currentProjectPath) record.projectPath = currentProjectPath;
    records.push(record);
  }

  return records;
}

module.exports = { parseCodexTranscript };
