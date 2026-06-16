const test = require("node:test");
const assert = require("node:assert");
const { parseClaudeTranscript } = require("../usage-history/parseClaude");

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

test("skips synthetic and zero-token assistant messages", () => {
  const synthetic = line({ type: "assistant", timestamp: "2026-06-16T18:00:00.000Z", message: { id: "syn", model: "<synthetic>", usage: { input_tokens: 5, output_tokens: 0 } } });
  const zero = assistant("z", { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
  assert.equal(parseClaudeTranscript([synthetic, zero].join("\n")).length, 0);
});

test("skips non-assistant lines and malformed JSON", () => {
  const text = ["not json", line({ type: "user", message: {} }), assistant("ok", { input_tokens: 1, output_tokens: 1 })].join("\n");
  assert.equal(parseClaudeTranscript(text).length, 1);
});
