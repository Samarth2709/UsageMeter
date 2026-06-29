const test = require("node:test");
const assert = require("node:assert/strict");
const { buildHelp } = require("../public/help");

const txt = (items) => items.map((i) => i.text).join(" | ");
const hasLevel = (items, level) => items.some((i) => i.level === level);

// A diagnostics object with both CLIs found and everything healthy.
function healthy() {
  return {
    homeDir: "/Users/x",
    env: { CLAUDE_CONFIG_DIR: null, CODEX_HOME: null },
    claude: { dir: "/Users/x/.claude/projects", exists: true, readable: true, files: 10 },
    configuredClaude: [],
    codex: [{ root: "/Users/x/.codex", exists: true, readable: true, sessionsFiles: 20, configured: false }],
    configured: { claude: [], codex: [] },
    totals: { claudeFiles: 10, codexFiles: 20 }
  };
}

test("both found → an ok item and no missing-CLI guidance", () => {
  const items = buildHelp(healthy());
  assert.ok(hasLevel(items, "ok"));
  assert.ok(!/No Claude transcripts/.test(txt(items)));
  assert.ok(!/No Codex transcripts/.test(txt(items)));
});

test("claude missing → claude guidance present", () => {
  const d = healthy();
  d.claude.files = 0;
  d.totals.claudeFiles = 0;
  const items = buildHelp(d);
  assert.ok(/No Claude transcripts/.test(txt(items)));
  assert.ok(/\.claude\/projects/.test(txt(items)));
});

test("codex missing → codex guidance present", () => {
  const d = healthy();
  d.totals.codexFiles = 0;
  d.codex[0].sessionsFiles = 0;
  const items = buildHelp(d);
  assert.ok(/No Codex transcripts/.test(txt(items)));
  assert.ok(/\.codex\/sessions/.test(txt(items)));
});

test("both missing → both guidance items", () => {
  const d = healthy();
  d.totals = { claudeFiles: 0, codexFiles: 0 };
  const items = buildHelp(d);
  assert.ok(/No Claude transcripts/.test(txt(items)));
  assert.ok(/No Codex transcripts/.test(txt(items)));
});

test("unreadable Claude dir → Full Disk Access warning", () => {
  const d = healthy();
  d.claude.readable = false;
  const items = buildHelp(d);
  assert.ok(hasLevel(items, "warn"));
  assert.ok(/Full Disk Access/.test(txt(items)));
});

test("unreadable Codex root → Full Disk Access warning", () => {
  const d = healthy();
  d.codex[0].readable = false;
  const items = buildHelp(d);
  assert.ok(/Full Disk Access/.test(txt(items)));
});

test("added Claude folder with zero files → empty-folder warning", () => {
  const d = healthy();
  d.configuredClaude = [{ dir: "/tmp/empty", exists: true, readable: true, files: 0 }];
  d.configured.claude = ["/tmp/empty"];
  const items = buildHelp(d);
  assert.ok(/no \.jsonl session files/i.test(txt(items)));
});

test("added Codex folder that doesn't exist → missing-folder warning", () => {
  const d = healthy();
  d.codex.push({ root: "/tmp/gone", exists: false, readable: true, sessionsFiles: 0, configured: true });
  d.configured.codex = ["/tmp/gone"];
  const items = buildHelp(d);
  assert.ok(/doesn't exist/.test(txt(items)));
});

test("env overrides are surfaced", () => {
  const d = healthy();
  d.env = { CLAUDE_CONFIG_DIR: "/custom/claude", CODEX_HOME: "/custom/codex" };
  const items = buildHelp(d);
  assert.ok(/CLAUDE_CONFIG_DIR=\/custom\/claude/.test(txt(items)));
  assert.ok(/CODEX_HOME=\/custom\/codex/.test(txt(items)));
});

test("null diagnostics → single unavailable info item", () => {
  const items = buildHelp(null);
  assert.equal(items.length, 1);
  assert.equal(items[0].level, "info");
  assert.ok(/Re-download/.test(items[0].text));
});
