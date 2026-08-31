const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { atomicWriteJson, atomicWriteJsonSync } = require("../atomic-file");

test("atomic JSON writes replace the target with private permissions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-atomic-"));
  const target = path.join(root, "private", "state.json");
  try {
    await atomicWriteJson(target, { version: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { version: 1 });
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);

    atomicWriteJsonSync(target, { version: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { version: 2 });

    atomicWriteJsonSync(target, { version: 3, nested: { ok: true } }, { pretty: false });
    assert.equal(fs.readFileSync(target, "utf8"), '{"version":3,"nested":{"ok":true}}\n');
    assert.deepEqual(
      fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith(".tmp")),
      []
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
