// State-aware help for the Diagnostics tab. Given the diagnostics object produced by
// usage-history/diagnostics.js (buildDiagnostics), returns guidance tailored to the
// CURRENT scan state — not static instructions. UMD so it loads as a classic <script>
// in the renderer (window.UMHelp) and via require() in node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.UMHelp = api;
})(typeof self !== "undefined" ? self : this, function () {
  function configuredCodex(d) {
    return (d.codex || []).filter((c) => c.configured);
  }

  // Returns [{ level: "ok"|"warn"|"info", text }] describing what to do next.
  function buildHelp(d) {
    if (!d) return [{ level: "info", text: "Diagnostics aren't available in this build. Re-download the latest version." }];

    const items = [];
    const claudeFound = (d.totals && d.totals.claudeFiles > 0) || false;
    const codexFound = (d.totals && d.totals.codexFiles > 0) || false;

    // Permission problems take priority — a found-but-unreadable folder looks like
    // "no data" but is really a Full Disk Access issue.
    const unreadable = [];
    if (d.claude && d.claude.readable === false) unreadable.push(d.claude.dir);
    for (const c of d.codex || []) if (c.readable === false) unreadable.push(c.root);
    for (const c of d.configuredClaude || []) if (c.readable === false) unreadable.push(c.dir);
    if (unreadable.length) {
      items.push({
        level: "warn",
        text: `A folder was found but couldn't be read (permission denied). Grant Full Disk Access to Usage Meter in System Settings → Privacy & Security → Full Disk Access, then reopen. Affected: ${unreadable.join(", ")}`
      });
    }

    if (claudeFound && codexFound) {
      items.push({
        level: "ok",
        text: `Both detected — Claude (${d.totals.claudeFiles} files) and Codex (${d.totals.codexFiles} files). Usage history should be populating.`
      });
    }

    if (!claudeFound) {
      const dir = (d.claude && d.claude.dir) || "~/.claude/projects";
      items.push({
        level: "info",
        text: `No Claude transcripts found. Usage history reads Claude Code CLI logs from ${dir}. If you use Claude Code, run it once and reopen this window. If your logs live elsewhere, add that folder under "Claude folders" below. If you only use the Claude API/SDK or an IDE, Claude history won't appear — that usage isn't logged locally.`
      });
    }

    if (!codexFound) {
      items.push({
        level: "info",
        text: `No Codex transcripts found. Usage history reads Codex CLI sessions from ~/.codex/sessions. If you use the Codex CLI, run it once and reopen. If your sessions live elsewhere, add that folder under "Codex folders" below. API-only usage isn't logged locally.`
      });
    }

    // Configured folders that don't help.
    const emptyConfigured = [];
    const missingConfigured = [];
    for (const c of d.configuredClaude || []) {
      if (!c.exists) missingConfigured.push(c.dir);
      else if (c.files === 0) emptyConfigured.push(c.dir);
    }
    for (const c of configuredCodex(d)) {
      if (!c.exists) missingConfigured.push(c.root);
      else if (c.sessionsFiles === 0) emptyConfigured.push(c.root);
    }
    if (missingConfigured.length) {
      items.push({ level: "warn", text: `A folder you added doesn't exist: ${missingConfigured.join(", ")}` });
    }
    if (emptyConfigured.length) {
      items.push({ level: "warn", text: `A folder you added has no .jsonl session files — check it points at your sessions directory. Empty: ${emptyConfigured.join(", ")}` });
    }

    if (d.env && d.env.CLAUDE_CONFIG_DIR) {
      items.push({ level: "info", text: `Claude is reading from CLAUDE_CONFIG_DIR=${d.env.CLAUDE_CONFIG_DIR}.` });
    }
    if (d.env && d.env.CODEX_HOME) {
      items.push({ level: "info", text: `Codex is also reading from CODEX_HOME=${d.env.CODEX_HOME}.` });
    }

    if (!items.length) items.push({ level: "info", text: "Nothing to report." });
    return items;
  }

  return { buildHelp };
});
