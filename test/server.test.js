const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../server");
const packageJson = require("../package.json");

test("default config includes first-run login rows", () => {
  const config = _test.defaultConfig();

  assert.deepEqual(
    config.identities.map((identity) => identity.id),
    ["codex-1", "codex-2", "claude-1"]
  );
  assert.deepEqual(
    config.identities.map((identity) => identity.type),
    ["codex", "codex", "claude"]
  );
});

test("empty configs normalize back to first-run identities", () => {
  const normalized = _test.normalizeConfig({ identities: [] });
  const serialized = _test.serializeConfig(normalized);

  assert.equal(serialized.accounts.length, 3);
  assert.equal(serialized.accounts[0].id, "codex-1");
  assert.equal(serialized.accounts[1].id, "codex-2");
  assert.equal(serialized.accounts[2].id, "claude-1");
});

test("Claude reset text parses into a concrete future timestamp", () => {
  const now = new Date(2026, 4, 2, 15, 0, 0, 0);
  const expected = new Date(2026, 4, 2, 17, 0, 0, 0).toISOString();

  assert.equal(_test.parseClaudeResetAt("May 2 at 5pm", now), expected);
});

test("production package config does not force unsigned mac builds", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(packageJson.build.mac, "identity"), false);
  assert.equal(packageJson.build.mac.hardenedRuntime, true);
});

test("Claude CLI paths do not use permission bypass flags", async () => {
  const serverSource = await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8");

  assert.equal(serverSource.includes("--dangerously-skip-permissions"), false);
  assert.equal(serverSource.includes("bypassPermissions"), false);
});
