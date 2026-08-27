const fs = require("node:fs");
const path = require("node:path");
const { codexHomeRoots, listAllTranscriptFiles } = require("./sources");
const { INDEX_FILE, INDEX_VERSION } = require("./index");

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
function buildDiagnostics({ homeDir, dataDir, extraRoots = {} } = {}) {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, ".claude");
  const claudeProjects = path.join(claudeConfigDir, "projects");
  const claude = { dir: claudeProjects, ...dirJsonlCount(claudeProjects) };

  // Default Codex homes (existing behavior) + any user-configured roots, flagged.
  const codex = codexHomeRoots(homeDir).map((root) => {
    const sessions = dirJsonlCount(path.join(root, "sessions"));
    const archived = dirJsonlCount(path.join(root, "archived_sessions"));
    return {
      root,
      exists: sessions.exists || archived.exists,
      readable: sessions.readable && archived.readable,
      sessionsFiles: sessions.files + archived.files,
      configured: false
    };
  });

  // User-configured extra folders are scanned recursively (whatever they point at).
  const configuredClaude = (extraRoots.claude || []).map((dir) => ({ dir, ...dirJsonlCount(dir) }));
  for (const dir of extraRoots.codex || []) {
    const c = dirJsonlCount(dir);
    codex.push({ root: dir, exists: c.exists, readable: c.readable, sessionsFiles: c.files, configured: true });
  }

  const all = listAllTranscriptFiles(homeDir, extraRoots);
  return {
    homeDir,
    env: {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null,
      CODEX_HOME: process.env.CODEX_HOME || null
    },
    cache: { path: path.join(dataDir || "", INDEX_FILE), version: INDEX_VERSION },
    claude,
    configuredClaude,
    codex,
    configured: { claude: extraRoots.claude || [], codex: extraRoots.codex || [] },
    totals: {
      claudeFiles: all.filter((f) => f.cli === "claude").length,
      codexFiles: all.filter((f) => f.cli === "codex").length
    }
  };
}

module.exports = { buildDiagnostics, dirJsonlCount };
