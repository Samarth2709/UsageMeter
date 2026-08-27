const test = require("node:test");
const assert = require("node:assert");
const { parseClaudeTranscript, parseClaudeTranscriptChunk } = require("../usage-history/parseClaude");

const line = (obj) => JSON.stringify(obj);
const assistant = (id, usage, extra = {}) => line({
  type: "assistant", requestId: "req_" + id, timestamp: "2026-06-16T18:00:00.000Z",
  isSidechain: false, message: { id: "msg_" + id, model: "claude-opus-4-8", usage }, ...extra
});

test("extracts normalized token buckets from assistant usage", () => {
  const text = assistant("a", { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 20, output_tokens: 10 });
  const recs = parseClaudeTranscript(text);
  assert.equal(recs.length, 1);
  assert.deepEqual(
    { ...recs[0], timestampMs: 0, day: recs[0].day },
    { timestampMs: 0, day: recs[0].day, cli: "claude", model: "claude-opus-4-8",
      inputTokens: 100, cachedReadTokens: 50, cacheWriteTokens: 20, outputTokens: 10, isSidechain: false }
  );
});

test("dedups repeated lines sharing message.id", () => {
  const u = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 };
  const text = [assistant("dup", u), assistant("dup", u)].join("\n");
  assert.equal(parseClaudeTranscript(text).length, 1);
});

test("uses the final Claude usage written for a streamed message", () => {
  const partial = assistant("stream", {
    input_tokens: 2,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
    output_tokens: 3
  });
  const final = assistant("stream", {
    input_tokens: 2,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
    output_tokens: 40
  });

  const records = parseClaudeTranscript([partial, final].join("\n"));
  assert.equal(records.length, 2);
  assert.equal(records[0].outputTokens, 3);
  assert.equal(records[1].outputTokens, 37);
  assert.equal(records[1].isCorrection, true);
});

test("counts the first nonzero streamed usage after an all-zero row as a call", () => {
  const zero = assistant("stream-zero", {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0
  });
  const nonzero = assistant("stream-zero", {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 40
  });

  const initial = parseClaudeTranscriptChunk(zero);
  const updated = parseClaudeTranscriptChunk(nonzero, initial.state);
  assert.equal(initial.records.length, 0);
  assert.deepEqual(initial.state.uncountedUsageIds, ["msg_stream-zero"]);
  assert.equal(updated.records.length, 1);
  assert.equal(updated.records[0].outputTokens, 40);
  assert.equal(updated.records[0].isCorrection, undefined);
  assert.deepEqual(updated.state.uncountedUsageIds, []);
});

test("skips synthetic and zero-token assistant messages", () => {
  const synthetic = line({ type: "assistant", timestamp: "2026-06-16T18:00:00.000Z", message: { id: "syn", model: "<synthetic>", usage: { input_tokens: 5, output_tokens: 0 } } });
  const zero = assistant("z", { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
  assert.equal(parseClaudeTranscript([synthetic, zero].join("\n")).length, 0);
});

test("skips non-assistant lines and malformed JSON", () => {
  const text = ["not json", line({ type: "user", message: {} }), assistant("ok", { input_tokens: 1, output_tokens: 1 })].join("\n");
  assert.equal(parseClaudeTranscript(text).length, 1);
});

test("carries only structural working-directory metadata into token records", () => {
  const text = [
    line({ type: "user", cwd: "/Users/you/Projects/usage-meter", message: { cwd: "/ignore/message-cwd" } }),
    assistant("cwd", { input_tokens: 1, output_tokens: 1 })
  ].join("\n");
  const [record] = parseClaudeTranscript(text);
  assert.equal(record.projectPath, "/Users/you/Projects/usage-meter");
});

test("incremental parsing preserves project context and deduplicates earlier message ids", () => {
  const first = parseClaudeTranscriptChunk([
    line({ type: "user", cwd: "/Users/you/Projects/usage-meter", message: {} }),
    assistant("same", { input_tokens: 5, output_tokens: 1 })
  ].join("\n"));
  const second = parseClaudeTranscriptChunk(
    [
      assistant("same", { input_tokens: 5, output_tokens: 1 }),
      assistant("new", { input_tokens: 7, output_tokens: 2 })
    ].join("\n"),
    first.state
  );

  assert.equal(first.records.length, 1);
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].projectPath, "/Users/you/Projects/usage-meter");
  assert.equal(second.records[0].inputTokens, 7);
  assert.deepEqual(Object.keys(second.state.usageById).sort(), ["msg_new", "msg_same"]);
});

test("an agent identity is not downgraded to its parent session", () => {
  const parsed = parseClaudeTranscriptChunk([
    assistant("agent", { input_tokens: 5, output_tokens: 1 }, {
      sessionId: "parent-session",
      agentId: "a5b6"
    }),
    assistant("parent", { input_tokens: 7, output_tokens: 2 }, {
      sessionId: "parent-session"
    })
  ].join("\n"));

  assert.equal(parsed.state.sessionIdentity, "agent-a5b6");
});
