const fs = require("node:fs");
const path = require("node:path");
const { codexHomeRoots, listAllTranscriptFiles } = require("./sources");
const { FILE_NAME, CACHE_VERSION } = require("./store");

// Count .jsonl files under a directory (recursively), and report whether the
// directory exists and was readable. Used to show exactly what the usage-history
// scanner can see on this machine — no parsing, just discovery.
function dirJsonlCount(dir) {
  let exists = false;
  try {
    exists = fs.statSync(dir).isDirectory();
  } catch {
    return { exists: false, readable: true, files: 0 };
  }
  if (!exists) return { exists: false, readable: true, files: 0 };

  let files = 0;
  let readable = true;
  const stack = [dir];
  try {
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files += 1;
      }
    }
  } catch {
    readable = false; // e.g. EACCES — surfaces a permissions problem
  }
  return { exists, readable, files };
}

// A snapshot of where usage history looks for transcripts and what it finds.
// Surfaced in the dashboard's Diagnostics tab so a user with empty history can
// copy it back to us — it distinguishes "no CLI transcripts" from "wrong location"
// from "permission denied" without us needing access to their machine.
function buildDiagnostics({ homeDir, dataDir } = {}) {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, ".claude");
  const claudeProjects = path.join(claudeConfigDir, "projects");
  const claude = { dir: claudeProjects, ...dirJsonlCount(claudeProjects) };

  const codex = codexHomeRoots(homeDir).map((root) => {
    const sessions = dirJsonlCount(path.join(root, "sessions"));
    const archived = dirJsonlCount(path.join(root, "archived_sessions"));
    return {
      root,
      exists: sessions.exists || archived.exists,
      readable: sessions.readable && archived.readable,
      sessionsFiles: sessions.files + archived.files
    };
  });

  const all = listAllTranscriptFiles(homeDir);
  return {
    homeDir,
    env: {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null,
      CODEX_HOME: process.env.CODEX_HOME || null
    },
    cache: { path: path.join(dataDir || "", FILE_NAME), version: CACHE_VERSION },
    claude,
    codex,
    totals: {
      claudeFiles: all.filter((f) => f.cli === "claude").length,
      codexFiles: all.filter((f) => f.cli === "codex").length
    }
  };
}

module.exports = { buildDiagnostics, dirJsonlCount };
