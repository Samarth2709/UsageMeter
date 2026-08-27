const path = require("node:path");

function normalizeSessionIdentity(value) {
  if (typeof value !== "string") return null;
  const identity = value.trim();
  if (!identity || identity.length > 512) return null;
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity)
    || /^agent-[0-9a-f]+$/i.test(identity)
  ) ? identity.toLowerCase() : identity;
}

function filenameSessionIdentity(filePath) {
  const name = path.basename(filePath, ".jsonl");
  const uuid = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  if (uuid) return uuid[0].toLowerCase();
  return /^agent-[0-9a-f]+$/i.test(name) ? name.toLowerCase() : null;
}

function structuralSessionIdentity(cli, value) {
  if (cli === "codex" && value?.type === "session_meta") {
    return normalizeSessionIdentity(value.payload?.id || value.payload?.session_id);
  }
  if (cli === "claude") {
    const parentSessionId = normalizeSessionIdentity(value?.sessionId || value?.session_id);
    const agentId = parentSessionId ? normalizeSessionIdentity(value?.agentId) : null;
    if (agentId) {
      return agentId.startsWith("agent-") ? agentId : `agent-${agentId}`;
    }
    return parentSessionId;
  }
  return null;
}

module.exports = {
  filenameSessionIdentity,
  normalizeSessionIdentity,
  structuralSessionIdentity
};
