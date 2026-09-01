const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { updateUsageIndex } = require("../usage-history/index");
const {
  mergeAndPrice,
  recordsToContribution,
  recordsToProjectContribution
} = require("../usage-history/aggregate");
const { parseClaudeTranscript } = require("../usage-history/parseClaude");
const { parseCodexTranscript } = require("../usage-history/parseCodex");
const { saveCache } = require("../usage-history/store");

const NOW = Date.parse("2026-07-29T16:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const jsonl = (value) => `${JSON.stringify(value)}\n`;

function codexMeta(model = "gpt-5.5", sessionId = null) {
  return jsonl({
    type: "session_meta",
    timestamp: iso(NOW),
    payload: {
      model,
      cwd: "/Users/you/Projects/kernel",
      ...(sessionId ? { id: sessionId } : {})
    }
  });
}

function codexTurn(timestampMs, input = 100, output = 10) {
  return jsonl({
    type: "event_msg",
    timestamp: iso(timestampMs),
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          output_tokens: output
        }
      }
    }
  });
}

function codexCumulativeTurn(timestampMs, input = 100, output = 10) {
  return jsonl({
    type: "event_msg",
    timestamp: iso(timestampMs),
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          output_tokens: output
        },
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          output_tokens: output
        }
      }
    }
  });
}

function claudeTurn(id, input = 100, output = 10) {
  return jsonl({
    type: "assistant",
    requestId: `req_${id}`,
    timestamp: iso(NOW),
    message: {
      id: `msg_${id}`,
      model: "claude-opus-4-8",
      usage: { input_tokens: input, output_tokens: output }
    }
  });
}

function fixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "um-index-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "um-index-data-"));
  const codexDir = path.join(homeDir, ".codex", "sessions");
  fs.mkdirSync(codexDir, { recursive: true });
  return {
    homeDir,
    dataDir,
    codexDir,
    cleanup() {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test("usage index reads only appended bytes and skips unchanged contents", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "rollout.jsonl");
    const initial = codexMeta() + codexTurn(NOW - 60000);
    fs.writeFileSync(file, initial);

    const first = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.equal(first.stats.rebuiltFiles, 1);
    assert.equal(first.stats.bytesRead, Buffer.byteLength(initial));

    const appended = codexTurn(NOW);
    fs.appendFileSync(file, appended);
    const second = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW + 1000 });
    assert.equal(second.stats.appendedFiles, 1);
    assert.equal(second.stats.rebuiltFiles, 0);
    assert.equal(second.stats.identityBytesRead, 0);
    assert.equal(second.stats.bytesRead, Buffer.byteLength(appended));

    const third = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW + 2000 });
    assert.equal(third.stats.bytesRead, 0);
    assert.equal(third.stats.appendedFiles, 0);
    assert.equal(third.stats.rebuiltFiles, 0);

    const history = mergeAndPrice(third.index.files, { rangeDays: 7, nowMs: NOW });
    assert.equal(history.range.tokens.calls, 2);
    assert.equal(history.range.tokens.input, 200);
    assert.equal(history.range.byProject[0].path, "/Users/you/Projects/kernel");
  } finally {
    f.cleanup();
  }
});

test("usage index keeps an incomplete trailing line until it becomes valid JSONL", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    fs.mkdirSync(claudeDir, { recursive: true });
    const file = path.join(claudeDir, "session.jsonl");
    const complete = claudeTurn("first");
    const second = claudeTurn("second");
    const splitAt = Math.floor(second.length / 2);
    fs.writeFileSync(file, complete + second.slice(0, splitAt));

    const first = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.equal(mergeAndPrice(first.index.files, { rangeDays: 7, nowMs: NOW }).range.tokens.calls, 1);

    fs.appendFileSync(file, second.slice(splitAt));
    const updated = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW + 1000 });
    const history = mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW });
    assert.equal(updated.stats.appendedFiles, 1);
    assert.equal(history.range.tokens.calls, 2);
    assert.equal(history.range.tokens.input, 200);
  } finally {
    f.cleanup();
  }
});

test("a file disappearing between stat and read preserves the previous entry", () => {
  const f = fixture();
  const originalOpenSync = fs.openSync;
  try {
    const file = path.join(f.codexDir, "rollout.jsonl");
    fs.writeFileSync(file, codexMeta() + codexTurn(NOW - 60_000));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    fs.appendFileSync(file, codexTurn(NOW));

    let fileOpenCount = 0;
    fs.openSync = function patchedOpenSync(filePath, ...args) {
      if (filePath === file && ++fileOpenCount === 2) {
        fs.unlinkSync(file);
        const error = new Error("transcript disappeared");
        error.code = "ENOENT";
        throw error;
      }
      return originalOpenSync.call(this, filePath, ...args);
    };
    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 1000
    });
    const history = mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW });

    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
    assert.equal(updated.index.files[file].processedBytes, updated.index.files[file].size);
  } finally {
    fs.openSync = originalOpenSync;
    f.cleanup();
  }
});

test("usage index applies a later Claude streaming total without adding a call", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    fs.mkdirSync(claudeDir, { recursive: true });
    const file = path.join(claudeDir, "session.jsonl");
    fs.writeFileSync(file, claudeTurn("stream", 2, 3));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.appendFileSync(file, claudeTurn("stream", 2, 40));
    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 1000
    });
    const history = mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW });
    assert.equal(updated.stats.appendedFiles, 1);
    assert.equal(history.range.tokens.input, 2);
    assert.equal(history.range.tokens.output, 40);
    assert.equal(history.range.tokens.calls, 1);
  } finally {
    f.cleanup();
  }
});

test("usage index rebuilds only a truncated file", () => {
  const f = fixture();
  try {
    const firstFile = path.join(f.codexDir, "first.jsonl");
    const secondFile = path.join(f.codexDir, "second.jsonl");
    fs.writeFileSync(firstFile, codexMeta() + codexTurn(NOW - 120000) + codexTurn(NOW - 60000));
    fs.writeFileSync(secondFile, codexMeta() + codexTurn(NOW));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    const replacement = codexMeta() + codexTurn(NOW, 7, 2);
    fs.writeFileSync(firstFile, replacement);
    const updated = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW + 1000 });
    assert.equal(updated.stats.rebuiltFiles, 1);
    assert.equal(updated.stats.appendedFiles, 0);
    assert.equal(updated.stats.bytesRead, Buffer.byteLength(replacement));

    const history = mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW });
    assert.equal(history.range.tokens.calls, 2);
    assert.equal(history.range.tokens.input, 107);
  } finally {
    f.cleanup();
  }
});

test("usage index rebuilds an atomically replaced file with unchanged size and mtime", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "rollout.jsonl");
    const replacementFile = path.join(f.codexDir, "replacement.jsonl");
    const fixedTime = new Date(NOW - 60_000);
    const original = codexMeta() + codexTurn(NOW, 100, 10);
    const replacement = codexMeta() + codexTurn(NOW, 900, 10);
    assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));

    fs.writeFileSync(file, original);
    fs.utimesSync(file, fixedTime, fixedTime);
    const first = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    const originalIno = first.index.files[file].ino;

    fs.writeFileSync(replacementFile, replacement);
    fs.utimesSync(replacementFile, fixedTime, fixedTime);
    fs.renameSync(replacementFile, file);
    assert.notEqual(fs.statSync(file).ino, originalIno);

    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 1000
    });
    assert.equal(updated.stats.rebuiltFiles, 1);
    assert.equal(updated.stats.bytesRead, Buffer.byteLength(replacement));
    assert.equal(
      mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW }).range.tokens.input,
      900
    );
  } finally {
    f.cleanup();
  }
});

test("forced repair corrects an earlier in-place rewrite while preserving incremental scans", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "rollout.jsonl");
    const filler = Array.from({ length: 180 }, (_, index) => jsonl({
      type: "other",
      timestamp: iso(NOW),
      payload: { index, pad: "x".repeat(100) }
    })).join("");
    const original = codexMeta() + codexTurn(NOW - 60_000, 100, 0) + filler;
    const rewritten = codexMeta() + codexTurn(NOW - 60_000, 900, 0) + filler;
    assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));
    assert.ok(Buffer.byteLength(original) > 8192);

    fs.writeFileSync(file, original);
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    const fd = fs.openSync(file, "r+");
    try {
      fs.writeSync(fd, rewritten, 0, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    fs.appendFileSync(file, codexTurn(NOW, 10, 0));
    const incremental = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 1000
    });
    assert.equal(incremental.stats.appendedFiles, 1);
    assert.equal(incremental.stats.rebuiltFiles, 0);

    const repaired = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 2000,
      forceRebuild: true
    });
    assert.equal(repaired.stats.rebuiltFiles, 1);
    assert.equal(
      mergeAndPrice(repaired.index.files, { rangeDays: 7, nowMs: NOW }).range.tokens.input,
      910
    );
  } finally {
    f.cleanup();
  }
});

test("missing files keep their indexed history through the 90-day dashboard", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "rollout.jsonl");
    fs.writeFileSync(file, codexMeta() + codexTurn(NOW));
    const first = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.equal(Object.keys(first.index.files).length, 1);

    fs.unlinkSync(file);
    const early = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW + 60000 });
    assert.equal(Object.keys(early.index.files).length, 1);

    const reconciled = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 1
    });
    assert.equal(Object.keys(reconciled.index.files).length, 1);
    assert.equal(reconciled.index.files[file].missing, true);
    assert.equal(reconciled.stats.retainedMissingFiles, 1);
    assert.equal(reconciled.stats.removedFiles, 0);
    assert.equal(reconciled.stats.bytesRead, 0);
    assert.equal(
      mergeAndPrice(reconciled.index.files, { rangeDays: 90, nowMs: NOW }).range.tokens.calls,
      1
    );

    const repaired = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 2,
      forceRebuild: true
    });
    assert.equal(repaired.index.files[file].missing, true);
    assert.equal(
      mergeAndPrice(repaired.index.files, { rangeDays: 90, nowMs: NOW }).range.tokens.calls,
      1
    );
  } finally {
    f.cleanup();
  }
});

test("missing files are pruned after their history leaves the 90-day dashboard", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "rollout.jsonl");
    fs.writeFileSync(file, codexMeta() + codexTurn(NOW));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    fs.unlinkSync(file);

    const reconciled = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 91 * 24 * 60 * 60 * 1000
    });
    assert.equal(Object.keys(reconciled.index.files).length, 0);
    assert.equal(reconciled.stats.removedFiles, 1);
  } finally {
    f.cleanup();
  }
});

test("moving a transcript rekeys its indexed contribution without double counting", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "rollout.jsonl");
    const archivedDir = path.join(f.homeDir, ".codex", "archived_sessions");
    const archivedFile = path.join(archivedDir, "rollout.jsonl");
    fs.writeFileSync(file, codexMeta() + codexTurn(NOW));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.mkdirSync(archivedDir, { recursive: true });
    fs.renameSync(file, archivedFile);
    const moved = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60_000
    });
    const history = mergeAndPrice(moved.index.files, { rangeDays: 7, nowMs: NOW });

    assert.deepEqual(Object.keys(moved.index.files), [archivedFile]);
    assert.equal(moved.stats.bytesRead, 0);
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
  } finally {
    f.cleanup();
  }
});

test("copy/delete moves rekey by session id without retaining a duplicate", () => {
  const f = fixture();
  try {
    const sessionId = "019fabcd-1234-7abc-8123-123456789abc";
    const file = path.join(f.codexDir, `rollout-${sessionId}.jsonl`);
    const archivedDir = path.join(f.homeDir, ".codex", "archived_sessions");
    const archivedFile = path.join(archivedDir, `rollout-${sessionId}.jsonl`);
    fs.writeFileSync(file, codexMeta() + codexTurn(NOW));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.mkdirSync(archivedDir, { recursive: true });
    fs.copyFileSync(file, archivedFile);
    const duringCopy = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60_000
    });
    assert.deepEqual(Object.keys(duringCopy.index.files), [file]);
    assert.equal(
      mergeAndPrice(duringCopy.index.files, { rangeDays: 7, nowMs: NOW }).range.tokens.calls,
      1
    );

    fs.unlinkSync(file);
    const moved = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 1
    });
    const history = mergeAndPrice(moved.index.files, { rangeDays: 7, nowMs: NOW });

    assert.deepEqual(Object.keys(moved.index.files), [archivedFile]);
    assert.equal(moved.stats.rebuiltFiles, 1);
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
  } finally {
    f.cleanup();
  }
});

test("structural session id overrides a misleading filename after rename", () => {
  const f = fixture();
  try {
    const sessionId = "019fabcd-1234-7abc-8123-123456789abc";
    const misleadingId = "029fabcd-1234-7abc-8123-123456789abc";
    const file = path.join(f.codexDir, `rollout-${sessionId}.jsonl`);
    const archivedDir = path.join(f.homeDir, ".codex", "archived_sessions");
    const archivedFile = path.join(archivedDir, `rollout-${misleadingId}.jsonl`);
    fs.writeFileSync(file, codexMeta("gpt-5.5", sessionId) + codexTurn(NOW));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.mkdirSync(archivedDir, { recursive: true });
    fs.copyFileSync(file, archivedFile);
    fs.unlinkSync(file);
    const moved = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 1
    });
    const history = mergeAndPrice(moved.index.files, { rangeDays: 7, nowMs: NOW });

    assert.deepEqual(Object.keys(moved.index.files), [archivedFile]);
    assert.equal(moved.index.files[archivedFile].sessionIdentity, sessionId);
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
  } finally {
    f.cleanup();
  }
});

test("post-parse dedup handles a structural id beyond the bounded header scan", () => {
  const f = fixture();
  try {
    const sessionId = "019fabcd-1234-7abc-8123-123456789abc";
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    const file = path.join(claudeDir, `${sessionId}.jsonl`);
    const renamed = path.join(claudeDir, "renamed-copy.jsonl");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(file, jsonl({
      type: "assistant",
      message: {
        id: "msg_oversized",
        model: "claude-opus-4-8",
        content: "x".repeat(256 * 1024),
        usage: { input_tokens: 100, output_tokens: 10 }
      },
      sessionId,
      requestId: "req_oversized",
      timestamp: iso(NOW)
    }));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.copyFileSync(file, renamed);
    fs.unlinkSync(file);
    const moved = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 1
    });
    const history = mergeAndPrice(moved.index.files, { rangeDays: 7, nowMs: NOW });

    assert.deepEqual(Object.keys(moved.index.files), [renamed]);
    assert.equal(moved.index.files[renamed].sessionIdentity, sessionId);
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
  } finally {
    f.cleanup();
  }
});

test("late duplicate metadata prevents reparsing and promotes a surviving copy", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    const firstFile = path.join(claudeDir, "a-copy.jsonl");
    const secondFile = path.join(claudeDir, "b-copy.jsonl");
    const transcript = jsonl({
      type: "assistant",
      sessionId: "shared-session-id",
      requestId: "req_shared",
      timestamp: iso(NOW),
      message: {
        id: "msg_shared",
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 10 }
      }
    });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(firstFile, transcript);
    fs.writeFileSync(secondFile, transcript);

    const initial = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.deepEqual(Object.keys(initial.index.files), [firstFile]);
    assert.deepEqual(Object.keys(initial.index.duplicates), [secondFile]);

    const unchanged = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 1000
    });
    assert.equal(unchanged.stats.parserBytesRead, 0);
    assert.equal(unchanged.stats.identityBytesRead, 0);
    assert.deepEqual(Object.keys(unchanged.index.files), [firstFile]);
    assert.deepEqual(Object.keys(unchanged.index.duplicates), [secondFile]);

    fs.unlinkSync(firstFile);
    const promoted = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 1
    });
    const history = mergeAndPrice(promoted.index.files, { rangeDays: 7, nowMs: NOW });

    assert.deepEqual(Object.keys(promoted.index.files), [secondFile]);
    assert.deepEqual(Object.keys(promoted.index.duplicates), []);
    assert.equal(promoted.stats.rebuiltFiles, 1);
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
  } finally {
    f.cleanup();
  }
});

test("an in-place rewrite invalidates cached duplicate session identity", () => {
  const f = fixture();
  try {
    const firstFile = path.join(f.codexDir, "a-copy.jsonl");
    const secondFile = path.join(f.codexDir, "b-copy.jsonl");
    const initialTime = new Date(NOW - 60_000);
    const rewrittenTime = new Date(NOW + 60_000);
    const oldTranscript = codexMeta("gpt-5.5", "session-old") + codexTurn(NOW, 100, 0);
    fs.writeFileSync(firstFile, oldTranscript);
    fs.writeFileSync(secondFile, oldTranscript);
    fs.utimesSync(firstFile, initialTime, initialTime);
    fs.utimesSync(secondFile, initialTime, initialTime);

    const initial = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.deepEqual(Object.keys(initial.index.files), [firstFile]);
    assert.deepEqual(Object.keys(initial.index.duplicates), [secondFile]);
    const duplicateIno = fs.statSync(secondFile).ino;

    fs.writeFileSync(
      secondFile,
      codexMeta("gpt-5.5", "session-new") + codexTurn(NOW, 900, 0)
    );
    fs.utimesSync(secondFile, rewrittenTime, rewrittenTime);
    assert.equal(fs.statSync(secondFile).ino, duplicateIno);
    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 120_000
    });
    const history = mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW });

    assert.deepEqual(Object.keys(updated.index.files), [firstFile, secondFile]);
    assert.deepEqual(Object.keys(updated.index.duplicates), []);
    assert.equal(updated.index.files[secondFile].sessionIdentity, "session-new");
    assert.equal(history.range.tokens.calls, 2);
    assert.equal(history.range.tokens.input, 1000);
  } finally {
    f.cleanup();
  }
});

test("forced repair revalidates same-session copies and retains the largest", () => {
  const f = fixture();
  try {
    const firstFile = path.join(f.codexDir, "a-copy.jsonl");
    const secondFile = path.join(f.codexDir, "b-copy.jsonl");
    const transcript = codexMeta("gpt-5.5", "shared-session") + codexTurn(NOW, 100, 0);
    fs.writeFileSync(firstFile, transcript);
    fs.writeFileSync(secondFile, transcript);
    const initial = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.deepEqual(Object.keys(initial.index.files), [firstFile]);
    assert.deepEqual(Object.keys(initial.index.duplicates), [secondFile]);

    fs.appendFileSync(secondFile, codexTurn(NOW + 1000, 200, 0));
    const repaired = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 2000,
      forceRebuild: true
    });
    const history = mergeAndPrice(repaired.index.files, { rangeDays: 7, nowMs: NOW + 2000 });

    assert.deepEqual(Object.keys(repaired.index.files), [secondFile]);
    assert.deepEqual(Object.keys(repaired.index.duplicates), [firstFile]);
    assert.equal(repaired.stats.rebuiltFiles, 2);
    assert.equal(history.range.tokens.calls, 2);
    assert.equal(history.range.tokens.input, 300);
  } finally {
    f.cleanup();
  }
});

test("a truncated primary promotes its unchanged fuller duplicate", () => {
  const f = fixture();
  try {
    const primaryFile = path.join(f.codexDir, "a-primary.jsonl");
    const fullerCopy = path.join(f.codexDir, "b-fuller-copy.jsonl");
    const firstTurn = codexMeta("gpt-5.5", "shared-session") + codexTurn(NOW, 100, 0);
    const fullTranscript = firstTurn + codexTurn(NOW + 1000, 200, 0);
    fs.writeFileSync(primaryFile, fullTranscript);
    fs.writeFileSync(fullerCopy, fullTranscript);
    const initial = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.deepEqual(Object.keys(initial.index.files), [primaryFile]);
    assert.deepEqual(Object.keys(initial.index.duplicates), [fullerCopy]);

    fs.truncateSync(primaryFile, Buffer.byteLength(firstTurn));
    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 2000
    });
    const history = mergeAndPrice(updated.index.files, {
      rangeDays: 7,
      nowMs: NOW + 2000
    });

    assert.deepEqual(Object.keys(updated.index.files), [fullerCopy]);
    assert.deepEqual(Object.keys(updated.index.duplicates), [primaryFile]);
    assert.equal(history.range.tokens.calls, 2);
    assert.equal(history.range.tokens.input, 300);
  } finally {
    f.cleanup();
  }
});

test("a rewritten smaller primary stays distinct from its fuller old-session copy", () => {
  const f = fixture();
  try {
    const primaryFile = path.join(f.codexDir, "a-primary.jsonl");
    const oldSessionCopy = path.join(f.codexDir, "b-old-session-copy.jsonl");
    const oldTranscript = codexMeta("gpt-5.5", "session-old")
      + codexTurn(NOW, 100, 0)
      + codexTurn(NOW + 1000, 200, 0);
    const newTranscript = codexMeta("gpt-5.5", "session-new")
      + codexTurn(NOW + 2000, 900, 0);
    fs.writeFileSync(primaryFile, oldTranscript);
    fs.writeFileSync(oldSessionCopy, oldTranscript);
    const initial = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.deepEqual(Object.keys(initial.index.files), [primaryFile]);
    assert.deepEqual(Object.keys(initial.index.duplicates), [oldSessionCopy]);
    const primaryIno = fs.statSync(primaryFile).ino;

    fs.writeFileSync(primaryFile, newTranscript);
    assert.equal(fs.statSync(primaryFile).ino, primaryIno);
    assert.ok(fs.statSync(primaryFile).size < fs.statSync(oldSessionCopy).size);
    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 3000
    });
    const next = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 4000
    });

    for (const result of [updated, next]) {
      const history = mergeAndPrice(result.index.files, {
        rangeDays: 7,
        nowMs: NOW + 4000
      });
      assert.ok(result.index.files[primaryFile]);
      assert.ok(result.index.files[oldSessionCopy]);
      assert.equal(result.index.files[primaryFile].sessionIdentity, "session-new");
      assert.equal(result.index.files[oldSessionCopy].sessionIdentity, "session-old");
      assert.equal(history.range.tokens.calls, 3);
      assert.equal(history.range.tokens.input, 1200);
    }
    assert.equal(updated.stats.identityBytesRead, 0);
  } finally {
    f.cleanup();
  }
});

test("forced repair revalidates metadata-invisible aggregate losers", () => {
  const f = fixture();
  try {
    const primaryFile = path.join(f.codexDir, "a-primary.jsonl");
    const oldSessionCopy = path.join(f.codexDir, "b-old-session-copy.jsonl");
    const oldTranscript = codexMeta("gpt-5.5", "session-old") + codexTurn(NOW, 100, 0);
    const newTranscript = codexMeta("gpt-5.5", "session-new") + codexTurn(NOW, 900, 0);
    assert.equal(Buffer.byteLength(newTranscript), Buffer.byteLength(oldTranscript));
    fs.writeFileSync(primaryFile, oldTranscript);
    fs.writeFileSync(oldSessionCopy, oldTranscript);
    const stableTime = new Date(NOW - 60_000);
    fs.utimesSync(primaryFile, stableTime, stableTime);
    const initial = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    const originalMtimeMs = initial.index.files[primaryFile].mtimeMs;
    assert.equal(originalMtimeMs, stableTime.getTime());

    fs.writeFileSync(primaryFile, newTranscript);
    fs.utimesSync(primaryFile, originalMtimeMs / 1000, originalMtimeMs / 1000);
    assert.equal(fs.statSync(primaryFile).mtimeMs, originalMtimeMs);
    fs.appendFileSync(oldSessionCopy, codexTurn(NOW + 1000, 200, 0));
    const repaired = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 2000,
      forceRebuild: true
    });
    const history = mergeAndPrice(repaired.index.files, {
      rangeDays: 7,
      nowMs: NOW + 2000
    });

    assert.ok(repaired.index.files[primaryFile]);
    assert.ok(repaired.index.files[oldSessionCopy]);
    assert.equal(repaired.index.files[primaryFile].sessionIdentity, "session-new");
    assert.equal(repaired.index.files[oldSessionCopy].sessionIdentity, "session-old");
    assert.equal(history.range.tokens.calls, 3);
    assert.equal(history.range.tokens.input, 1200);
  } finally {
    f.cleanup();
  }
});

test("a failed aggregate revalidation remains retryable after force repair", () => {
  const f = fixture();
  const originalOpenSync = fs.openSync;
  try {
    const primaryFile = path.join(f.codexDir, "a-primary.jsonl");
    const oldSessionCopy = path.join(f.codexDir, "b-old-session-copy.jsonl");
    const oldTranscript = codexMeta("gpt-5.5", "session-old") + codexTurn(NOW, 100, 0);
    const newTranscript = codexMeta("gpt-5.5", "session-new") + codexTurn(NOW, 900, 0);
    assert.equal(Buffer.byteLength(newTranscript), Buffer.byteLength(oldTranscript));
    fs.writeFileSync(primaryFile, oldTranscript);
    fs.writeFileSync(oldSessionCopy, oldTranscript);
    const stableTime = new Date(NOW - 60_000);
    fs.utimesSync(primaryFile, stableTime, stableTime);
    const initial = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    const originalMtimeMs = initial.index.files[primaryFile].mtimeMs;
    assert.equal(originalMtimeMs, stableTime.getTime());

    fs.writeFileSync(primaryFile, newTranscript);
    fs.utimesSync(primaryFile, originalMtimeMs / 1000, originalMtimeMs / 1000);
    assert.equal(fs.statSync(primaryFile).mtimeMs, originalMtimeMs);
    fs.appendFileSync(oldSessionCopy, codexTurn(NOW + 1000, 200, 0));
    let blocked = false;
    fs.openSync = function patchedOpenSync(filePath, ...args) {
      if (filePath === primaryFile && !blocked) {
        blocked = true;
        const error = new Error("aggregate revalidation denied");
        error.code = "EACCES";
        throw error;
      }
      return originalOpenSync.call(this, filePath, ...args);
    };
    const attempted = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 2000,
      forceRebuild: true
    });
    const attemptedHistory = mergeAndPrice(attempted.index.files, {
      rangeDays: 7,
      nowMs: NOW + 2000
    });

    assert.deepEqual(Object.keys(attempted.index.files), [primaryFile]);
    assert.equal(attempted.index.files[primaryFile].needsRebuild, true);
    assert.equal(attemptedHistory.range.tokens.calls, 1);
    assert.equal(attemptedHistory.range.tokens.input, 100);

    fs.openSync = originalOpenSync;
    const retried = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 3000
    });
    const retriedHistory = mergeAndPrice(retried.index.files, {
      rangeDays: 7,
      nowMs: NOW + 3000
    });
    assert.ok(retried.index.files[primaryFile]);
    assert.ok(retried.index.files[oldSessionCopy]);
    assert.equal(retried.index.files[primaryFile].sessionIdentity, "session-new");
    assert.equal(retried.index.files[oldSessionCopy].sessionIdentity, "session-old");
    assert.equal(retriedHistory.range.tokens.calls, 3);
    assert.equal(retriedHistory.range.tokens.input, 1200);
  } finally {
    fs.openSync = originalOpenSync;
    f.cleanup();
  }
});

test("a duplicate rewritten during commit is revalidated in the same refresh", () => {
  const f = fixture();
  const originalStatSync = fs.statSync;
  try {
    const oldSessionFile = path.join(f.codexDir, "a-old-session.jsonl");
    const rewrittenFile = path.join(f.codexDir, "b-rewritten.jsonl");
    const firstOldTurn = codexMeta("gpt-5.5", "session-old") + codexTurn(NOW, 100, 0);
    const fullOldSession = firstOldTurn + codexTurn(NOW + 1000, 200, 0);
    const newSession = codexMeta("gpt-5.5", "session-new") + codexTurn(NOW + 2000, 900, 0);
    assert.equal(Buffer.byteLength(newSession), Buffer.byteLength(firstOldTurn));
    fs.writeFileSync(oldSessionFile, fullOldSession);
    fs.writeFileSync(rewrittenFile, firstOldTurn);

    let rewrittenStats = 0;
    fs.statSync = function patchedStatSync(filePath, ...args) {
      if (filePath === rewrittenFile && ++rewrittenStats === 2) {
        fs.writeFileSync(rewrittenFile, newSession);
      }
      return originalStatSync.call(this, filePath, ...args);
    };
    const initial = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 3000
    });
    fs.statSync = originalStatSync;
    const next = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 4000
    });

    for (const result of [initial, next]) {
      const history = mergeAndPrice(result.index.files, {
        rangeDays: 7,
        nowMs: NOW + 4000
      });
      assert.ok(result.index.files[oldSessionFile]);
      assert.ok(result.index.files[rewrittenFile]);
      assert.equal(result.index.files[oldSessionFile].sessionIdentity, "session-old");
      assert.equal(result.index.files[rewrittenFile].sessionIdentity, "session-new");
      assert.equal(history.range.tokens.calls, 3);
      assert.equal(history.range.tokens.input, 1200);
    }
  } finally {
    fs.statSync = originalStatSync;
    f.cleanup();
  }
});

test("a promoted duplicate disappearing before parse preserves the incumbent", () => {
  const f = fixture();
  const originalStatSync = fs.statSync;
  try {
    const firstFile = path.join(f.codexDir, "a-copy.jsonl");
    const secondFile = path.join(f.codexDir, "b-copy.jsonl");
    const transcript = codexMeta("gpt-5.5", "shared-session") + codexTurn(NOW, 100, 0);
    fs.writeFileSync(firstFile, transcript);
    fs.writeFileSync(secondFile, transcript);
    const initial = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.deepEqual(Object.keys(initial.index.files), [firstFile]);
    assert.deepEqual(Object.keys(initial.index.duplicates), [secondFile]);

    fs.appendFileSync(secondFile, codexTurn(NOW + 1000, 200, 0));
    let secondFileStats = 0;
    fs.statSync = function patchedStatSync(filePath, ...args) {
      if (filePath === secondFile && ++secondFileStats === 3) {
        fs.unlinkSync(secondFile);
        const error = new Error("promoted duplicate disappeared");
        error.code = "ENOENT";
        throw error;
      }
      return originalStatSync.call(this, filePath, ...args);
    };
    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 2000
    });
    const history = mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW + 2000 });

    assert.deepEqual(Object.keys(updated.index.files), [firstFile]);
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
  } finally {
    fs.statSync = originalStatSync;
    f.cleanup();
  }
});

test("an initial duplicate winner disappearing falls back in the same refresh", () => {
  const f = fixture();
  const originalStatSync = fs.statSync;
  try {
    const smallerFile = path.join(f.codexDir, "a-smaller-copy.jsonl");
    const largerFile = path.join(f.codexDir, "b-larger-copy.jsonl");
    const firstTurn = codexMeta("gpt-5.5", "shared-session") + codexTurn(NOW, 100, 0);
    fs.writeFileSync(smallerFile, firstTurn);
    fs.writeFileSync(largerFile, firstTurn + codexTurn(NOW + 1000, 200, 0));

    let largerFileStats = 0;
    fs.statSync = function patchedStatSync(filePath, ...args) {
      if (filePath === largerFile && ++largerFileStats === 2) {
        fs.unlinkSync(largerFile);
        const error = new Error("initial duplicate winner disappeared");
        error.code = "ENOENT";
        throw error;
      }
      return originalStatSync.call(this, filePath, ...args);
    };
    const initial = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 2000
    });
    const history = mergeAndPrice(initial.index.files, {
      rangeDays: 7,
      nowMs: NOW + 2000
    });

    assert.deepEqual(Object.keys(initial.index.files), [smallerFile]);
    assert.equal(initial.stats.rebuiltFiles, 1);
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
  } finally {
    fs.statSync = originalStatSync;
    f.cleanup();
  }
});

test("a new larger same-session copy matches a clean rebuild", () => {
  const f = fixture();
  try {
    const primaryFile = path.join(f.codexDir, "primary.jsonl");
    const largerCopy = path.join(f.codexDir, "larger-copy.jsonl");
    const separateFile = path.join(f.codexDir, "separate.jsonl");
    const sessionOne = codexMeta("gpt-5.5", "session-one")
      + codexTurn(NOW - 2000, 100, 0)
      + codexTurn(NOW - 1000, 200, 0);
    const largerSessionOne = sessionOne + codexTurn(NOW, 300, 0);
    const sessionTwo = codexMeta("gpt-5.5", "session-two") + codexTurn(NOW, 900, 0);
    fs.writeFileSync(primaryFile, sessionOne);
    fs.writeFileSync(separateFile, sessionTwo);
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.writeFileSync(largerCopy, largerSessionOne);
    const incremental = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 1000
    });
    const clean = updateUsageIndex({
      homeDir: f.homeDir,
      index: { version: 3, lastReconciledAt: 0, files: {}, duplicates: {} },
      nowMs: NOW + 1000
    });
    const incrementalHistory = mergeAndPrice(incremental.index.files, {
      rangeDays: 7,
      nowMs: NOW + 1000
    });
    const cleanHistory = mergeAndPrice(clean.index.files, {
      rangeDays: 7,
      nowMs: NOW + 1000
    });

    assert.ok(incremental.index.files[largerCopy]);
    assert.ok(incremental.index.duplicates[primaryFile]);
    assert.ok(incremental.stats.parserBytesRead > 0);
    assert.deepEqual(incrementalHistory.range.tokens, cleanHistory.range.tokens);
    assert.equal(incrementalHistory.range.tokens.calls, 4);
    assert.equal(incrementalHistory.range.tokens.input, 1500);
  } finally {
    f.cleanup();
  }
});

test("a parsed agent identity cannot demote its discovery-time parent", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    const parentFile = path.join(claudeDir, "parent.jsonl");
    const agentFile = path.join(
      claudeDir,
      "029fabcd-1234-7abc-8123-123456789abc.jsonl"
    );
    const parentPrefix = Array.from({ length: 2600 }, (_, index) => jsonl({
      type: "user",
      sessionId: "parent-session",
      message: { index, pad: "x".repeat(100) }
    })).join("");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(parentFile, jsonl({
      type: "assistant",
      sessionId: "parent-session",
      requestId: "req_parent",
      timestamp: iso(NOW),
      message: {
        id: "msg_parent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 10 }
      }
    }));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.writeFileSync(agentFile, parentPrefix + jsonl({
      type: "assistant",
      sessionId: "parent-session",
      agentId: "a5b6",
      requestId: "req_agent",
      timestamp: iso(NOW),
      message: {
        id: "msg_agent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 200, output_tokens: 20 }
      }
    }));
    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 1000
    });
    const history = mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW + 1000 });

    assert.ok(updated.index.files[parentFile]);
    assert.ok(updated.index.files[agentFile]);
    assert.equal(updated.index.files[agentFile].sessionIdentity, "agent-a5b6");
    assert.equal(history.range.tokens.calls, 2);
    assert.equal(history.range.tokens.input, 300);
  } finally {
    f.cleanup();
  }
});

test("a parsed agent identity cannot overwrite retained parent history", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    const parentFile = path.join(claudeDir, "parent.jsonl");
    const agentFile = path.join(
      claudeDir,
      "029fabcd-1234-7abc-8123-123456789abc.jsonl"
    );
    const parentPrefix = Array.from({ length: 2600 }, (_, index) => jsonl({
      type: "user",
      sessionId: "parent-session",
      message: { index, pad: "x".repeat(100) }
    })).join("");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(parentFile, jsonl({
      type: "assistant",
      sessionId: "parent-session",
      requestId: "req_parent",
      timestamp: iso(NOW),
      message: {
        id: "msg_parent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 10 }
      }
    }));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    fs.unlinkSync(parentFile);

    fs.writeFileSync(agentFile, parentPrefix + jsonl({
      type: "assistant",
      sessionId: "parent-session",
      agentId: "a5b6",
      requestId: "req_agent",
      timestamp: iso(NOW),
      message: {
        id: "msg_agent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 200, output_tokens: 20 }
      }
    }));
    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 1
    });
    const next = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 1001
    });
    for (const result of [updated, next]) {
      const history = mergeAndPrice(result.index.files, {
        rangeDays: 7,
        nowMs: NOW + 60 * 60 * 1000 + 1001
      });
      assert.ok(result.index.files[parentFile]);
      assert.ok(result.index.files[agentFile]);
      assert.equal(result.index.files[agentFile].sessionIdentity, "agent-a5b6");
      assert.equal(history.range.tokens.calls, 2);
      assert.equal(history.range.tokens.input, 300);
    }
  } finally {
    f.cleanup();
  }
});

test("an in-place primary identity rewrite cannot suppress the old-session copy", () => {
  const f = fixture();
  try {
    const primaryFile = path.join(f.codexDir, "primary.jsonl");
    const oldSessionCopy = path.join(f.codexDir, "old-session-copy.jsonl");
    const oldTranscript = codexMeta("gpt-5.5", "session-old") + codexTurn(NOW, 100, 0);
    const newTranscript = codexMeta("gpt-5.5", "session-new")
      + codexTurn(NOW, 900, 0)
      + jsonl({ type: "other", payload: { pad: "x".repeat(1024) } });
    fs.writeFileSync(primaryFile, oldTranscript);
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    const primaryIno = fs.statSync(primaryFile).ino;

    fs.writeFileSync(primaryFile, newTranscript);
    fs.writeFileSync(oldSessionCopy, oldTranscript);
    assert.equal(fs.statSync(primaryFile).ino, primaryIno);
    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 1000
    });
    const next = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 2000
    });
    for (const result of [updated, next]) {
      const history = mergeAndPrice(result.index.files, {
        rangeDays: 7,
        nowMs: NOW + 2000
      });
      assert.ok(result.index.files[primaryFile]);
      assert.ok(result.index.files[oldSessionCopy]);
      assert.equal(result.index.files[primaryFile].sessionIdentity, "session-new");
      assert.equal(result.index.files[oldSessionCopy].sessionIdentity, "session-old");
      assert.equal(history.range.tokens.calls, 2);
      assert.equal(history.range.tokens.input, 1000);
    }
  } finally {
    f.cleanup();
  }
});

test("a full rebuild replaces a stale Claude agent identity with its parent", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    const file = path.join(claudeDir, "custom.jsonl");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(file, jsonl({
      type: "assistant",
      sessionId: "parent-old",
      agentId: "a5b6",
      requestId: "req_old_agent",
      timestamp: iso(NOW),
      message: {
        id: "msg_old_agent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 0 }
      }
    }));
    const initial = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    const originalIno = fs.statSync(file).ino;
    assert.equal(initial.index.files[file].sessionIdentity, "agent-a5b6");

    fs.writeFileSync(file, jsonl({
      type: "assistant",
      sessionId: "parent-new",
      requestId: "req_new_parent",
      timestamp: iso(NOW + 1000),
      message: {
        id: "msg_new_parent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 900, output_tokens: 0 }
      }
    }));
    assert.equal(fs.statSync(file).ino, originalIno);
    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 2000
    });
    const history = mergeAndPrice(updated.index.files, {
      rangeDays: 7,
      nowMs: NOW + 2000
    });

    assert.equal(updated.index.files[file].sessionIdentity, "parent-new");
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 900);
  } finally {
    f.cleanup();
  }
});

test("forced rebuild does not seed a stale Claude agent identity", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    const file = path.join(claudeDir, "custom.jsonl");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(file, jsonl({
      type: "assistant",
      sessionId: "parent-old",
      agentId: "a5b6",
      requestId: "req_old_agent",
      timestamp: iso(NOW),
      message: {
        id: "msg_old_agent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 0 }
      }
    }));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.writeFileSync(file, jsonl({
      type: "assistant",
      sessionId: "parent-new",
      requestId: "req_new_parent",
      timestamp: iso(NOW + 1000),
      message: {
        id: "msg_new_parent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 900, output_tokens: 0 }
      }
    }));
    const repaired = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 2000,
      forceRebuild: true
    });
    const history = mergeAndPrice(repaired.index.files, {
      rangeDays: 7,
      nowMs: NOW + 2000
    });

    assert.equal(repaired.index.files[file].sessionIdentity, "parent-new");
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 900);
  } finally {
    f.cleanup();
  }
});

test("renamed copy/delete moves rekey by structural session id", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "custom-name.jsonl");
    const archivedDir = path.join(f.homeDir, ".codex", "archived_sessions");
    const archivedFile = path.join(archivedDir, "renamed-copy.jsonl");
    fs.writeFileSync(
      file,
      codexMeta("gpt-5.5", "canonical-session-id") + codexTurn(NOW)
    );
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.mkdirSync(archivedDir, { recursive: true });
    fs.copyFileSync(file, archivedFile);
    fs.unlinkSync(file);
    const moved = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 1
    });
    const history = mergeAndPrice(moved.index.files, { rangeDays: 7, nowMs: NOW });

    assert.deepEqual(Object.keys(moved.index.files), [archivedFile]);
    assert.equal(moved.index.files[archivedFile].sessionIdentity, "canonical-session-id");
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
  } finally {
    f.cleanup();
  }
});

test("renamed Claude subagents keep their agent identity instead of the parent session", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    const file = path.join(claudeDir, "agent-a5b6.jsonl");
    const renamed = path.join(claudeDir, "renamed-copy.jsonl");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(file, jsonl({
      type: "assistant",
      sessionId: "parent-session-id",
      agentId: "a5b6",
      requestId: "req_agent",
      timestamp: iso(NOW),
      message: {
        id: "msg_agent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 10 }
      }
    }));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.copyFileSync(file, renamed);
    fs.unlinkSync(file);
    const moved = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 1
    });
    const history = mergeAndPrice(moved.index.files, { rangeDays: 7, nowMs: NOW });

    assert.deepEqual(Object.keys(moved.index.files), [renamed]);
    assert.equal(moved.index.files[renamed].sessionIdentity, "agent-a5b6");
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
  } finally {
    f.cleanup();
  }
});

test("Claude workflow journals cannot replace real agent transcripts", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    const agentFile = path.join(claudeDir, "agent-a5b6.jsonl");
    const journalFile = path.join(claudeDir, "journal.jsonl");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(agentFile, jsonl({
      type: "assistant",
      sessionId: "parent-session-id",
      agentId: "a5b6",
      requestId: "req_agent",
      timestamp: iso(NOW),
      message: {
        id: "msg_agent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 10 }
      }
    }));
    fs.writeFileSync(journalFile, jsonl({
      type: "started",
      agentId: "a5b6",
      details: "x".repeat(10 * 1024)
    }));

    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW
    });
    const history = mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW });

    assert.ok(updated.index.files[agentFile]);
    assert.equal(updated.index.files[journalFile].sessionIdentity, null);
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
  } finally {
    f.cleanup();
  }
});

test("an agent filename stays distinct when early rows only name the parent session", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    const parentFile = path.join(claudeDir, "parent.jsonl");
    const agentFile = path.join(claudeDir, "agent-a5b6.jsonl");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(parentFile, jsonl({
      type: "assistant",
      sessionId: "parent-session-id",
      requestId: "req_parent",
      timestamp: iso(NOW),
      message: {
        id: "msg_parent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 10 }
      }
    }));
    fs.writeFileSync(agentFile, jsonl({
      type: "assistant",
      sessionId: "parent-session-id",
      requestId: "req_agent",
      timestamp: iso(NOW),
      message: {
        id: "msg_agent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 200, output_tokens: 20 }
      }
    }));

    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW
    });
    const history = mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW });

    assert.equal(updated.index.files[parentFile].sessionIdentity, "parent-session-id");
    assert.equal(updated.index.files[agentFile].sessionIdentity, "agent-a5b6");
    assert.equal(history.range.tokens.calls, 2);
    assert.equal(history.range.tokens.input, 300);
  } finally {
    f.cleanup();
  }
});

test("a renamed agent with a capped parent-only prefix is parsed before dedup", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    const parentFile = path.join(claudeDir, "parent.jsonl");
    const agentFile = path.join(claudeDir, "agent-a5b6.jsonl");
    const renamed = path.join(claudeDir, "renamed-agent.jsonl");
    const parentPrefix = Array.from({ length: 2600 }, (_, index) => jsonl({
      type: "user",
      sessionId: "parent-session-id",
      message: { index, pad: "x".repeat(100) }
    })).join("");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(parentFile, jsonl({
      type: "assistant",
      sessionId: "parent-session-id",
      requestId: "req_parent",
      timestamp: iso(NOW),
      message: {
        id: "msg_parent",
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 10 }
      }
    }));
    fs.writeFileSync(agentFile, parentPrefix + jsonl({
      type: "assistant",
      sessionId: "parent-session-id",
      agentId: "a5b6",
      requestId: "req_agent_one",
      timestamp: iso(NOW),
      message: {
        id: "msg_agent_one",
        model: "claude-opus-4-8",
        usage: { input_tokens: 200, output_tokens: 20 }
      }
    }));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.copyFileSync(agentFile, renamed);
    fs.unlinkSync(agentFile);
    fs.appendFileSync(renamed, jsonl({
      type: "assistant",
      sessionId: "parent-session-id",
      agentId: "a5b6",
      requestId: "req_agent_two",
      timestamp: iso(NOW),
      message: {
        id: "msg_agent_two",
        model: "claude-opus-4-8",
        usage: { input_tokens: 300, output_tokens: 30 }
      }
    }));
    const updated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 1
    });
    const history = mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW });

    assert.ok(updated.index.files[parentFile]);
    assert.ok(updated.index.files[renamed]);
    assert.equal(updated.index.files[renamed].sessionIdentity, "agent-a5b6");
    assert.equal(history.range.tokens.calls, 3);
    assert.equal(history.range.tokens.input, 600);
  } finally {
    f.cleanup();
  }
});

test("a missing structural identity is scanned once and cached", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "no-identity.jsonl");
    const filler = Array.from({ length: 2600 }, (_, index) => jsonl({
      type: "other",
      timestamp: iso(NOW),
      payload: { index, pad: "x".repeat(100) }
    })).join("");
    fs.writeFileSync(file, codexMeta() + codexTurn(NOW) + filler);

    const first = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.equal(first.stats.identityBytesRead, 256 * 1024);
    assert.equal(first.index.files[file].identityScanComplete, true);

    const second = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 1000
    });
    assert.equal(second.stats.identityBytesRead, 0);
    assert.equal(second.stats.parserBytesRead, 0);
    assert.equal(second.stats.bytesRead, 0);
  } finally {
    f.cleanup();
  }
});

test("atomic replacement refreshes a cached structural session identity", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "custom-name.jsonl");
    const replacement = path.join(f.codexDir, "replacement.jsonl");
    const renamed = path.join(f.codexDir, "renamed-copy.jsonl");
    fs.writeFileSync(file, codexMeta("gpt-5.5", "old-session") + codexTurn(NOW, 100, 0));
    updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });

    fs.writeFileSync(
      replacement,
      codexMeta("gpt-5.5", "new-session") + codexTurn(NOW, 200, 0)
    );
    fs.renameSync(replacement, file);
    const rebuilt = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 1000
    });
    assert.equal(rebuilt.index.files[file].sessionIdentity, "new-session");
    assert.equal(
      mergeAndPrice(rebuilt.index.files, { rangeDays: 7, nowMs: NOW }).range.tokens.input,
      200
    );

    fs.copyFileSync(file, renamed);
    fs.unlinkSync(file);
    const moved = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 60 * 60 * 1000 + 1
    });
    assert.deepEqual(Object.keys(moved.index.files), [renamed]);
    assert.equal(
      mergeAndPrice(moved.index.files, { rangeDays: 7, nowMs: NOW }).range.tokens.input,
      200
    );
  } finally {
    f.cleanup();
  }
});

test("legacy migration reparses live Claude transcripts with current streaming semantics", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    const file = path.join(claudeDir, "session.jsonl");
    const partial = claudeTurn("stream", 2, 3);
    const text = partial + claudeTurn("stream", 2, 40);
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(file, text);
    const stat = fs.statSync(file);
    const oldRecords = parseClaudeTranscript(partial);
    saveCache(f.dataDir, {
      version: 7,
      files: {
        [file]: {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          cli: "claude",
          contribution: recordsToContribution(oldRecords),
          projectContribution: recordsToProjectContribution(oldRecords, file, "claude")
        }
      }
    });
    saveCache(f.dataDir, {
      version: 3,
      files: {
        [file]: {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          cli: "claude",
          records: oldRecords.map(({ cli, ...record }) => record)
        }
      }
    }, "window-points.json");

    const migrated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW
    });
    assert.equal(migrated.stats.identityBytesRead, 0);
    assert.equal(migrated.stats.bytesRead, Buffer.byteLength(text));
    assert.equal(migrated.stats.rebuiltFiles, 1);
    const history = mergeAndPrice(migrated.index.files, { rangeDays: 7, nowMs: NOW });
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 2);
    assert.equal(history.range.tokens.output, 40);
  } finally {
    f.cleanup();
  }
});

test("a rebuilt legacy file appends incrementally after migration", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "rollout.jsonl");
    const initial = codexMeta() + codexTurn(NOW - 60_000);
    fs.writeFileSync(file, initial);
    const stat = fs.statSync(file);
    const records = parseCodexTranscript(initial);
    saveCache(f.dataDir, {
      version: 7,
      files: {
        [file]: {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          cli: "codex",
          contribution: recordsToContribution(records),
          projectContribution: recordsToProjectContribution(records, file, "codex")
        }
      }
    });
    saveCache(f.dataDir, {
      version: 3,
      files: {
        [file]: {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          cli: "codex",
          records: records.map(({ cli, ...record }) => record)
        }
      }
    }, "window-points.json");

    const migrated = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.equal(migrated.stats.rebuiltFiles, 1);
    assert.equal(migrated.stats.bytesRead, Buffer.byteLength(initial));

    const appended = codexTurn(NOW);
    fs.appendFileSync(file, appended);
    const rebuilt = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW + 1000
    });
    assert.equal(rebuilt.stats.appendedFiles, 1);
    assert.equal(rebuilt.stats.rebuiltFiles, 0);
    assert.equal(rebuilt.stats.bytesRead, Buffer.byteLength(appended));
  } finally {
    f.cleanup();
  }
});

test("legacy migration reparses repeated Codex cumulative snapshots", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "rollout.jsonl");
    const firstTurn = codexCumulativeTurn(NOW - 60_000);
    const text = codexMeta() + firstTurn + codexCumulativeTurn(NOW);
    fs.writeFileSync(file, text);
    const stat = fs.statSync(file);
    const firstRecord = parseCodexTranscript(codexMeta() + firstTurn)[0];
    const oldRecords = [
      firstRecord,
      { ...firstRecord, timestampMs: NOW, day: "2026-07-29" }
    ];
    saveCache(f.dataDir, {
      version: 7,
      files: {
        [file]: {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          cli: "codex",
          contribution: recordsToContribution(oldRecords),
          projectContribution: recordsToProjectContribution(oldRecords, file, "codex")
        }
      }
    });
    saveCache(f.dataDir, {
      version: 3,
      files: {
        [file]: {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          cli: "codex",
          records: oldRecords.map(({ cli, ...record }) => record)
        }
      }
    }, "window-points.json");

    const migrated = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    const history = mergeAndPrice(migrated.index.files, { rangeDays: 7, nowMs: NOW });

    assert.equal(migrated.stats.rebuiltFiles, 1);
    assert.equal(migrated.stats.bytesRead, Buffer.byteLength(text));
    assert.equal(history.range.tokens.calls, 1);
    assert.equal(history.range.tokens.input, 100);
  } finally {
    f.cleanup();
  }
});

test("an index schema mismatch rebuilds transcripts instead of accepting legacy data", () => {
  const f = fixture();
  try {
    const file = path.join(f.codexDir, "rollout.jsonl");
    const current = codexMeta() + codexTurn(NOW, 900, 10);
    fs.writeFileSync(file, current);
    fs.writeFileSync(
      path.join(f.dataDir, "usage-index.json"),
      JSON.stringify({ version: 999, files: {} })
    );

    const rebuilt = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW
    });
    assert.equal(rebuilt.stats.rebuiltFiles, 1);
    assert.equal(rebuilt.stats.bytesRead, Buffer.byteLength(current));
    assert.equal(
      mergeAndPrice(rebuilt.index.files, { rangeDays: 7, nowMs: NOW }).range.tokens.input,
      900
    );
  } finally {
    f.cleanup();
  }
});

test("version 2 migration restores retained legacy history for deleted transcripts", () => {
  const f = fixture();
  try {
    const deletedFile = path.join(f.homeDir, ".claude", "projects", "old", "deleted.jsonl");
    const contribution = {
      "2026-07-29": {
        "claude::claude-haiku-4-5-20251001": {
          inputTokens: 20,
          cachedReadTokens: 30,
          cacheWriteTokens: 40,
          outputTokens: 10,
          calls: 1
        }
      }
    };
    saveCache(f.dataDir, {
      version: 7,
      files: {
        [deletedFile]: {
          mtimeMs: NOW,
          size: 100,
          cli: "claude",
          contribution,
          projectContribution: {}
        }
      }
    });
    fs.writeFileSync(
      path.join(f.dataDir, "usage-index.json"),
      JSON.stringify({ version: 2, lastReconciledAt: NOW, files: {} })
    );

    const migrated = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW
    });
    assert.equal(migrated.index.version, 4);
    assert.equal(migrated.index.files[deletedFile].missing, true);
    assert.equal(
      mergeAndPrice(migrated.index.files, { rangeDays: 90, nowMs: NOW }).range.tokens.total,
      100
    );
  } finally {
    f.cleanup();
  }
});

test("Claude message ids are owned globally across forked sessions", () => {
  const f = fixture();
  try {
    const claudeDir = path.join(f.homeDir, ".claude", "projects", "p");
    fs.mkdirSync(claudeDir, { recursive: true });
    const shared = claudeTurn("shared", 100, 10);
    fs.writeFileSync(path.join(claudeDir, "parent.jsonl"), shared);
    fs.writeFileSync(
      path.join(claudeDir, "child.jsonl"),
      shared + claudeTurn("child-only", 7, 2)
    );

    const updated = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    const history = mergeAndPrice(updated.index.files, { rangeDays: 7, nowMs: NOW });

    assert.equal(history.range.tokens.calls, 2);
    assert.equal(history.range.tokens.input, 107);
    assert.equal(history.range.tokens.output, 12);
  } finally {
    f.cleanup();
  }
});

test("semantically corrupt current indexes fail closed during refresh and repair", () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.dataDir, "usage-index.json"),
      JSON.stringify({ version: 4, files: { "/missing": null }, duplicates: {} })
    );
    const refreshed = updateUsageIndex({ homeDir: f.homeDir, dataDir: f.dataDir, nowMs: NOW });
    assert.deepEqual(refreshed.index.files, {});

    const repaired = updateUsageIndex({
      homeDir: f.homeDir,
      dataDir: f.dataDir,
      nowMs: NOW,
      forceRebuild: true
    });
    assert.deepEqual(repaired.index.files, {});
  } finally {
    f.cleanup();
  }
});
