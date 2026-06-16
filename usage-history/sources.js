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
  // Claude Code's default transcript location. CLAUDE_CONFIG_DIR overrides ~/.claude.
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, ".claude");
  walkJsonl(path.join(configDir, "projects"), out);
  return out;
}

// Codex sessions live under a "Codex home" that contains a sessions/ directory.
// The same machine can have several: the default ~/.codex, a CODEX_HOME override,
// per-account homes this app configures, and third-party launchers (e.g. Orca)
// that run Codex under their own home. Scanning only ~/.codex misses everything an
// external launcher produced — which can be the bulk of real usage.
function codexHomeRoots(homeDir) {
  const roots = [];
  const add = (p) => { if (p && !roots.includes(p)) roots.push(p); };

  add(path.join(homeDir, ".codex"));
  if (process.env.CODEX_HOME) add(process.env.CODEX_HOME);

  // App-configured Codex identities (each directory is itself a CODEX_HOME).
  const identitiesDir = path.join(homeDir, ".rate-limit-tool", "codex-identities");
  try {
    for (const entry of fs.readdirSync(identitiesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) add(path.join(identitiesDir, entry.name));
    }
  } catch { /* no configured identities */ }

  // Orca runs Codex agents under a nested runtime home (sessions live in home/).
  add(path.join(homeDir, "Library", "Application Support", "orca", "codex-runtime-home", "home"));

  return roots;
}

function listCodexFiles(homeDir) {
  const out = [];
  for (const root of codexHomeRoots(homeDir)) {
    walkJsonl(path.join(root, "sessions"), out);
    walkJsonl(path.join(root, "archived_sessions"), out);
  }
  return out;
}

function listAllTranscriptFiles(homeDir) {
  return [
    ...listClaudeFiles(homeDir).map((p) => ({ path: p, cli: "claude" })),
    ...listCodexFiles(homeDir).map((p) => ({ path: p, cli: "codex" }))
  ];
}

module.exports = { listClaudeFiles, listCodexFiles, listAllTranscriptFiles, codexHomeRoots };
