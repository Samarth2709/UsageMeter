const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listAllTranscriptFiles } = require("../usage-history/sources");

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-home-"));
  const claudeDir = path.join(home, ".claude", "projects", "proj-a");
  const codexDir = path.join(home, ".codex", "sessions", "2026", "06", "16");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "s1.jsonl"), "{}");
  fs.writeFileSync(path.join(codexDir, "rollout-x.jsonl"), "{}");
  fs.writeFileSync(path.join(claudeDir, "ignore.txt"), "nope");
  return home;
}

test("finds claude and codex jsonl files tagged by cli", () => {
  const home = tmpHome();
  const files = listAllTranscriptFiles(home);
  const claude = files.filter((f) => f.cli === "claude").map((f) => path.basename(f.path));
  const codex = files.filter((f) => f.cli === "codex").map((f) => path.basename(f.path));
  assert.deepEqual(claude.sort(), ["s1.jsonl"]);
  assert.deepEqual(codex.sort(), ["rollout-x.jsonl"]);
});

test("returns empty list when directories are missing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-empty-"));
  assert.deepEqual(listAllTranscriptFiles(home), []);
});

function mkExtra(name, file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  if (file) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "{}\n");
  }
  return dir;
}

test("extraRoots: includes an extra Claude folder tagged claude", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-h-"));
  const extra = mkExtra("um-xc-", "a.jsonl");
  const files = listAllTranscriptFiles(home, { claude: [extra] });
  assert.equal(files.filter((f) => f.cli === "claude").length, 1);
});

test("extraRoots: includes an extra Codex folder tagged codex", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-h-"));
  const extra = mkExtra("um-xx-", "r.jsonl");
  const files = listAllTranscriptFiles(home, { codex: [extra] });
  assert.equal(files.filter((f) => f.cli === "codex").length, 1);
});

test("extraRoots: walks an extra folder recursively", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-h-"));
  const extra = mkExtra("um-xr-", "deep/nested/x.jsonl");
  const files = listAllTranscriptFiles(home, { codex: [extra] });
  assert.equal(files.filter((f) => f.cli === "codex").length, 1);
});

test("extraRoots: a nonexistent extra folder is ignored without throwing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-h-"));
  const files = listAllTranscriptFiles(home, { claude: ["/no/such/dir/xyz"] });
  assert.deepEqual(files, []);
});

test("extraRoots: omitting the param behaves like defaults-only", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-h-"));
  const claudeDir = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "s.jsonl"), "{}");
  assert.deepEqual(listAllTranscriptFiles(home), listAllTranscriptFiles(home, {}));
});

test("extraRoots: a configured folder overlapping a default is not double-counted", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-h-"));
  const codexSessions = path.join(home, ".codex", "sessions");
  fs.mkdirSync(codexSessions, { recursive: true });
  fs.writeFileSync(path.join(codexSessions, "r.jsonl"), "{}");
  // Point an extra codex root at the same ~/.codex home that's already scanned.
  const files = listAllTranscriptFiles(home, { codex: [path.join(home, ".codex")] });
  assert.equal(files.filter((f) => f.cli === "codex").length, 1);
});
