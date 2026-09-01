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

// Walk each user-configured extra root recursively for .jsonl files.
function walkRoots(roots) {
  const out = [];
  for (const root of roots || []) walkJsonl(root, out);
  return out;
}

// extraRoots: { claude?: string[], codex?: string[] } — additional user-configured
// folders, scanned recursively and tagged with the given CLI (in addition to the
// defaults). Deduped by path so a configured folder overlapping a default isn't
// counted twice.
function listAllTranscriptFiles(homeDir, extraRoots = {}) {
  const tagged = [
    ...listClaudeFiles(homeDir).map((p) => ({ path: p, cli: "claude" })),
    ...walkRoots(extraRoots.claude).map((p) => ({ path: p, cli: "claude" })),
    ...listCodexFiles(homeDir).map((p) => ({ path: p, cli: "codex" })),
    ...walkRoots(extraRoots.codex).map((p) => ({ path: p, cli: "codex" }))
  ];
  const seen = new Set();
  const out = [];
  for (const file of tagged) {
    let identity = `${file.cli}:path:${file.path}`;
    try {
      const stat = fs.statSync(file.path);
      identity = `${file.cli}:inode:${stat.dev}:${stat.ino}`;
    } catch { /* discovery tolerates files disappearing mid-scan */ }
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(file);
  }
  return out;
}

module.exports = { listClaudeFiles, listCodexFiles, listAllTranscriptFiles, codexHomeRoots, walkRoots };
