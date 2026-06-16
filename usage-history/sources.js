const fs = require("node:fs");
const path = require("node:path");

function walkJsonl(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

function listClaudeFiles(homeDir) {
  const out = [];
  walkJsonl(path.join(homeDir, ".claude", "projects"), out);
  return out;
}

function listCodexFiles(homeDir) {
  const out = [];
  walkJsonl(path.join(homeDir, ".codex", "sessions"), out);
  walkJsonl(path.join(homeDir, ".codex", "archived_sessions"), out);
  return out;
}

function listAllTranscriptFiles(homeDir) {
  return [
    ...listClaudeFiles(homeDir).map((p) => ({ path: p, cli: "claude" })),
    ...listCodexFiles(homeDir).map((p) => ({ path: p, cli: "codex" }))
  ];
}

module.exports = { listClaudeFiles, listCodexFiles, listAllTranscriptFiles };
