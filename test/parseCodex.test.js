const test = require("node:test");
const assert = require("node:assert");
const { parseCodexTranscript } = require("../usage-history/parseCodex");

const L = (obj) => JSON.stringify(obj);
const meta = (model) => L({ type: "session_meta", timestamp: "2026-06-16T18:00:00.000Z", payload: { model } });
const tc = (ts, last, total) => L({
  type: "event_msg", timestamp: ts,
  payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } }
});

test("emits one record per token_count using per-turn delta and tracks model", () => {
  const text = [
    meta("gpt-5.5-codex"),
    tc("2026-06-16T18:00:01.000Z", { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 10 },
       { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 10 }),
    tc("2026-06-16T18:00:02.000Z", { input_tokens: 120, cached_input_tokens: 80, output_tokens: 15 },
       { input_tokens: 220, cached_input_tokens: 120, output_tokens: 25 })
  ].join("\n");

  const recs = parseCodexTranscript(text);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].model, "gpt-5.5-codex");
  assert.equal(recs[0].inputTokens, 50);
  assert.equal(recs[0].cachedReadTokens, 40);
  assert.equal(recs[0].cacheWriteTokens, 10);
  assert.equal(recs[1].inputTokens, 40);
  assert.equal(recs[1].outputTokens, 15);
});

test("skips inherited token events until a model context is available", () => {
  const text = [
    L({ type: "session_meta", timestamp: "2026-06-16T18:00:00.000Z", payload: { source: { subagent: {} } } }),
    tc("2026-06-16T18:00:01.000Z", { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 10 }, {}),
    L({ type: "turn_context", timestamp: "2026-06-16T18:00:02.000Z", payload: { model: "gpt-5.7-new" } }),
    tc("2026-06-16T18:00:03.000Z", { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, {})
  ].join("\n");

  const recs = parseCodexTranscript(text);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].model, "gpt-5.7-new");
  assert.equal(recs[0].inputTokens, 60);
});

test("skips zero-token token_count events", () => {
  const text = [
    meta("gpt-5.5"),
    tc("2026-06-16T18:00:01.000Z", { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
       { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 })
  ].join("\n");
  assert.equal(parseCodexTranscript(text).length, 0);
});

test("skips malformed lines without throwing", () => {
  const text = ["garbage", meta("gpt-5.4"), tc("2026-06-16T18:00:01.000Z", { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 }, { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 })].join("\n");
  const recs = parseCodexTranscript(text);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].model, "gpt-5.4");
});

test("carries payload working-directory metadata into token records", () => {
  const text = [
    L({ type: "session_meta", timestamp: "2026-06-16T18:00:00.000Z", payload: { model: "gpt-5.5", cwd: "/Users/you/Projects/kernel" } }),
    tc("2026-06-16T18:00:01.000Z", { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 }, {})
  ].join("\n");
  const [record] = parseCodexTranscript(text);
  assert.equal(record.projectPath, "/Users/you/Projects/kernel");
});
