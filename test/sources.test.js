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
