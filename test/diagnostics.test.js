const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDiagnostics } = require("../usage-history/diagnostics");

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
}

// Run fn with a fresh temp home and CLAUDE_CONFIG_DIR/CODEX_HOME cleared, restoring after.
function withTempHome(fn, env = {}) {
  const prev = { c: process.env.CLAUDE_CONFIG_DIR, x: process.env.CODEX_HOME };
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-diag-"));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    if (prev.c === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev.c;
    if (prev.x === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev.x;
  }
}

test("buildDiagnostics counts transcripts per location", () => {
  withTempHome((home) => {
    touch(path.join(home, ".claude", "projects", "p1", "a.jsonl"));
    touch(path.join(home, ".claude", "projects", "p1", "b.jsonl"));
    touch(path.join(home, ".codex", "sessions", "s1.jsonl"));

    const d = buildDiagnostics({ homeDir: home, dataDir: path.join(home, ".rate-limit-tool") });

    assert.equal(d.claude.exists, true);
    assert.equal(d.claude.files, 2);
    const defaultCodex = d.codex.find((c) => c.root === path.join(home, ".codex"));
    assert.ok(defaultCodex, "default ~/.codex root should be listed");
    assert.equal(defaultCodex.exists, true);
    assert.equal(defaultCodex.sessionsFiles, 1);
    assert.equal(d.totals.claudeFiles, 2);
    assert.equal(d.totals.codexFiles, 1);
    assert.ok(d.cache.path.endsWith("usage-history.json"));
    assert.equal(typeof d.cache.version, "number");
  });
});

test("buildDiagnostics reports zero/absent when nothing is present", () => {
  withTempHome((home) => {
    const d = buildDiagnostics({ homeDir: home, dataDir: path.join(home, ".rate-limit-tool") });
    assert.equal(d.claude.exists, false);
    assert.equal(d.claude.files, 0);
    assert.equal(d.totals.claudeFiles, 0);
    assert.equal(d.totals.codexFiles, 0);
    assert.equal(d.env.CLAUDE_CONFIG_DIR, null);
    assert.equal(d.env.CODEX_HOME, null);
  });
});

test("buildDiagnostics honors CODEX_HOME and surfaces it", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "um-codexhome-"));
  try {
    touch(path.join(codexHome, "sessions", "x.jsonl"));
    withTempHome((home) => {
      const d = buildDiagnostics({ homeDir: home, dataDir: path.join(home, ".rate-limit-tool") });
      assert.equal(d.env.CODEX_HOME, codexHome);
      const root = d.codex.find((c) => c.root === codexHome);
      assert.ok(root, "CODEX_HOME root should be scanned");
      assert.equal(root.sessionsFiles, 1);
      assert.equal(d.totals.codexFiles, 1);
    }, { CODEX_HOME: codexHome });
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("buildDiagnostics lists a configured Claude folder with its file count", () => {
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "um-cc-"));
  try {
    touch(path.join(extra, "nested", "a.jsonl"));
    withTempHome((home) => {
      const d = buildDiagnostics({ homeDir: home, dataDir: home, extraRoots: { claude: [extra] } });
      const entry = (d.configuredClaude || []).find((c) => c.dir === extra);
      assert.ok(entry, "configured claude root should be listed");
      assert.equal(entry.exists, true);
      assert.equal(entry.files, 1);
    });
  } finally {
    fs.rmSync(extra, { recursive: true, force: true });
  }
});

test("buildDiagnostics marks a configured Codex root with configured:true", () => {
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "um-cx-"));
  try {
    touch(path.join(extra, "r.jsonl"));
    withTempHome((home) => {
      const d = buildDiagnostics({ homeDir: home, dataDir: home, extraRoots: { codex: [extra] } });
      const entry = d.codex.find((c) => c.root === extra);
      assert.ok(entry, "configured codex root should appear in codex[]");
      assert.equal(entry.configured, true);
      assert.equal(entry.sessionsFiles, 1);
    });
  } finally {
    fs.rmSync(extra, { recursive: true, force: true });
  }
});

test("buildDiagnostics echoes configured paths under .configured", () => {
  withTempHome((home) => {
    const d = buildDiagnostics({
      homeDir: home,
      dataDir: home,
      extraRoots: { claude: ["/x/claude"], codex: ["/x/codex"] }
    });
    assert.deepEqual(d.configured, { claude: ["/x/claude"], codex: ["/x/codex"] });
  });
});

test("buildDiagnostics totals include configured roots", () => {
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "um-ct-"));
  try {
    touch(path.join(extra, "a.jsonl"));
    touch(path.join(extra, "b.jsonl"));
    withTempHome((home) => {
      const d = buildDiagnostics({ homeDir: home, dataDir: home, extraRoots: { claude: [extra] } });
      assert.equal(d.totals.claudeFiles, 2);
    });
  } finally {
    fs.rmSync(extra, { recursive: true, force: true });
  }
});
