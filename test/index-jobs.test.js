const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { performIndexWork } = require("../usage-history/index-jobs");

test("history index job returns a compact payload and incremental scan stats", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "um-job-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "um-job-data-"));
  const nowMs = Date.parse("2026-07-29T16:00:00.000Z");
  const dir = path.join(homeDir, ".codex", "sessions");
  const file = path.join(dir, "rollout.jsonl");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, [
    JSON.stringify({
      type: "session_meta",
      timestamp: new Date(nowMs - 60000).toISOString(),
      payload: { model: "gpt-5.5", cwd: "/Users/you/Projects/kernel" }
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: new Date(nowMs - 60000).toISOString(),
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 10
          }
        }
      }
    })
  ].join("\n"));

  try {
    const first = performIndexWork({
      operation: "history",
      homeDir,
      dataDir,
      nowMs,
      rangeDays: 7,
      limits: [{
        cli: "codex",
        label: "weekly",
        durationSeconds: 7 * 24 * 60 * 60,
        usedPercent: 50,
        resetAt: new Date(nowMs + 60 * 60 * 1000).toISOString()
      }],
      appVersion: "test"
    });
    assert.equal(first.stats.rebuiltFiles, 1);
    assert.equal(first.payload.range.tokens.calls, 1);
    assert.equal(first.payload.range.byProject[0].label, "kernel");
    assert.equal(first.payload.windowValues.length, 1);
    assert.equal(first.payload.appVersion, "test");

    const second = performIndexWork({
      operation: "history",
      homeDir,
      dataDir,
      nowMs: nowMs + 1000,
      rangeDays: 7,
      limits: [],
      appVersion: "test"
    });
    assert.equal(second.stats.bytesRead, 0);
    assert.equal(second.stats.rebuiltFiles, 0);
    assert.equal(second.payload.range.tokens.calls, 1);

    const multiple = performIndexWork({
      operation: "history",
      homeDir,
      dataDir,
      nowMs: nowMs + 2000,
      rangeDays: [7, 30, 90],
      limits: [],
      appVersion: "test"
    });
    assert.deepEqual(Object.keys(multiple.payloads), ["7", "30", "90"]);
    assert.equal(multiple.payloads[7].range.tokens.calls, 1);
    assert.equal(multiple.stats.bytesRead, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
