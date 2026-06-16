# Usage History Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track Claude + Codex token usage over time from local CLI transcripts, shown in a dedicated dashboard window with daily totals split by CLI/model and an API-equivalent dollar value.

**Architecture:** A self-contained `usage-history/` module: pure parsers turn transcript text into normalized token records; an incremental on-disk cache (`~/.rate-limit-tool/usage-history.json`) rolls records into per-file daily contributions; a pure rollup sums a date range and prices it into API-equivalent dollars; Electron IPC + an HTTP route serve it to a new frameless dashboard window opened from the popover.

**Tech Stack:** Node.js (CommonJS, matching the repo), Electron, `node --test`, hand-rolled SVG (no chart dependency).

**Reference spec:** `docs/superpowers/specs/2026-06-16-usage-history-tracker-design.md`

**Verified facts (2026-06-16):**
- Claude assistant line: `timestamp`, `message.id`/`requestId` (dedup), `message.model`, `message.usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens}`, `isSidechain`.
- Codex `event_msg` with `payload.type==="token_count"`: `payload.info.last_token_usage` is a **per-turn delta** (summing deltas == `total_token_usage`); model name comes from earlier `session_meta`/`turn_context` events.

---

## Normalized types (used across tasks)

```
TokenRecord = {
  timestampMs, day: "YYYY-MM-DD" (local), cli: "claude"|"codex", model,
  inputTokens, cachedReadTokens, cacheWriteTokens, outputTokens, isSidechain?
}
Buckets = { inputTokens, cachedReadTokens, cacheWriteTokens, outputTokens }
Contribution = { [day]: { ["<cli>::<model>"]: Buckets } }
FileCacheEntry = { mtimeMs, size, cli, contribution: Contribution }
Cache = { version: 1, files: { [absPath]: FileCacheEntry } }
```

---

## Task 1: Pricing module

**Files:**
- Create: `usage-history/pricing.js`
- Test: `test/pricing.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/pricing.test.js
const test = require("node:test");
const assert = require("node:assert");
const { rateKeyForModel, priceRecord, FALLBACK } = require("../usage-history/pricing");

test("maps Claude/Codex model ids to rate keys", () => {
  assert.equal(rateKeyForModel("claude", "claude-opus-4-8"), "claude-opus");
  assert.equal(rateKeyForModel("claude", "claude-sonnet-4-6"), "claude-sonnet");
  assert.equal(rateKeyForModel("claude", "claude-haiku-4-5"), "claude-haiku");
  assert.equal(rateKeyForModel("codex", "gpt-5.5-codex"), "gpt-5.5");
  assert.equal(rateKeyForModel("codex", "gpt-5.4"), "gpt-5.4");
  assert.equal(rateKeyForModel("codex", "mystery-model"), null);
});

test("prices a known model by bucket", () => {
  // 1M fresh input @15 + 1M cached @1.5 + 1M cacheWrite @18.75 + 1M output @75
  const r = priceRecord("claude", "claude-opus-4-8", {
    inputTokens: 1_000_000, cachedReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000, outputTokens: 1_000_000
  });
  assert.equal(r.modelKnown, true);
  assert.equal(r.rateKey, "claude-opus");
  assert.ok(Math.abs(r.dollars - (15 + 1.5 + 18.75 + 75)) < 1e-9);
});

test("unknown model uses fallback and flags modelKnown=false", () => {
  const r = priceRecord("codex", "mystery", { inputTokens: 1_000_000, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  assert.equal(r.modelKnown, false);
  assert.ok(Math.abs(r.dollars - FALLBACK.input) < 1e-9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pricing.test.js`
Expected: FAIL — `Cannot find module '../usage-history/pricing'`.

- [ ] **Step 3: Write minimal implementation**

```js
// usage-history/pricing.js
// USD per 1,000,000 tokens. Verify Claude rates against the claude-api skill and
// Codex rates against current OpenAI pricing when revisiting; this table is the
// single source of truth for pricing.
const RATES = {
  "claude-opus":   { input: 15.0, cachedRead: 1.5, cacheWrite: 18.75, output: 75.0 },
  "claude-sonnet": { input: 3.0,  cachedRead: 0.3, cacheWrite: 3.75,  output: 15.0 },
  "claude-haiku":  { input: 1.0,  cachedRead: 0.1, cacheWrite: 1.25,  output: 5.0 },
  "gpt-5.5":       { input: 5.0,  cachedRead: 0.5, cacheWrite: 0,     output: 30.0 },
  "gpt-5.4":       { input: 2.5,  cachedRead: 0.25, cacheWrite: 0,    output: 15.0 }
};
const FALLBACK = { input: 3.0, cachedRead: 0.3, cacheWrite: 3.75, output: 15.0 };

function rateKeyForModel(cli, model) {
  const m = String(model || "").toLowerCase();
  if (cli === "claude") {
    if (m.includes("opus")) return "claude-opus";
    if (m.includes("sonnet")) return "claude-sonnet";
    if (m.includes("haiku")) return "claude-haiku";
    return null;
  }
  if (m.includes("5.5")) return "gpt-5.5";
  if (m.includes("5.4")) return "gpt-5.4";
  return null;
}

function priceRecord(cli, model, buckets) {
  const key = rateKeyForModel(cli, model);
  const rate = key ? RATES[key] : FALLBACK;
  const per = (tokens, r) => ((Number(tokens) || 0) * r) / 1_000_000;
  const dollars =
    per(buckets.inputTokens, rate.input) +
    per(buckets.cachedReadTokens, rate.cachedRead) +
    per(buckets.cacheWriteTokens, rate.cacheWrite) +
    per(buckets.outputTokens, rate.output);
  return { dollars, rateKey: key, modelKnown: key !== null };
}

module.exports = { RATES, FALLBACK, rateKeyForModel, priceRecord };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pricing.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add usage-history/pricing.js test/pricing.test.js
git commit -m "- Add usage-history pricing module with model-to-rate mapping and API-equivalent cost"
```

---

## Task 2: Local-day helper

**Files:**
- Create: `usage-history/day.js`
- Test: `test/day.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/day.test.js
const test = require("node:test");
const assert = require("node:assert");
const { localDay } = require("../usage-history/day");

test("formats a timestamp as local YYYY-MM-DD", () => {
  const ms = new Date(2026, 5, 16, 13, 45, 0).getTime(); // local June 16 2026
  assert.equal(localDay(ms), "2026-06-16");
});

test("uses local midnight boundary", () => {
  const justBeforeMidnight = new Date(2026, 5, 16, 23, 59, 59).getTime();
  const justAfterMidnight = new Date(2026, 5, 17, 0, 0, 1).getTime();
  assert.equal(localDay(justBeforeMidnight), "2026-06-16");
  assert.equal(localDay(justAfterMidnight), "2026-06-17");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/day.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// usage-history/day.js
function localDay(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

module.exports = { localDay };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/day.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add usage-history/day.js test/day.test.js
git commit -m "- Add local-timezone day bucketing helper for usage history"
```

---

## Task 3: Claude transcript parser

**Files:**
- Create: `usage-history/parseClaude.js`
- Test: `test/parseClaude.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/parseClaude.test.js
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

test("skips non-assistant lines and malformed JSON", () => {
  const text = ["not json", line({ type: "user", message: {} }), assistant("ok", { input_tokens: 1, output_tokens: 1 })].join("\n");
  assert.equal(parseClaudeTranscript(text).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/parseClaude.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// usage-history/parseClaude.js
const { localDay } = require("./day");

function parseClaudeTranscript(text) {
  const records = [];
  const seen = new Set();

  for (const rawLine of String(text || "").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj.type !== "assistant") continue;

    const msg = obj.message || {};
    const usage = msg.usage;
    if (!usage) continue;

    const id = msg.id || obj.requestId;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }

    const ts = Date.parse(obj.timestamp);
    if (!Number.isFinite(ts)) continue;

    records.push({
      timestampMs: ts,
      day: localDay(ts),
      cli: "claude",
      model: msg.model || "unknown",
      inputTokens: Number(usage.input_tokens) || 0,
      cachedReadTokens: Number(usage.cache_read_input_tokens) || 0,
      cacheWriteTokens: Number(usage.cache_creation_input_tokens) || 0,
      outputTokens: Number(usage.output_tokens) || 0,
      isSidechain: Boolean(obj.isSidechain)
    });
  }

  return records;
}

module.exports = { parseClaudeTranscript };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/parseClaude.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add usage-history/parseClaude.js test/parseClaude.test.js
git commit -m "- Add Claude transcript parser with message-id dedup and normalized token buckets"
```

---

## Task 4: Codex transcript parser

**Files:**
- Create: `usage-history/parseCodex.js`
- Test: `test/parseCodex.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/parseCodex.test.js
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
    tc("2026-06-16T18:00:01.000Z", { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
       { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }),
    tc("2026-06-16T18:00:02.000Z", { input_tokens: 120, cached_input_tokens: 80, output_tokens: 15 },
       { input_tokens: 220, cached_input_tokens: 120, output_tokens: 25 })
  ].join("\n");

  const recs = parseCodexTranscript(text);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].model, "gpt-5.5-codex");
  // fresh input = input - cached
  assert.equal(recs[0].inputTokens, 60);
  assert.equal(recs[0].cachedReadTokens, 40);
  assert.equal(recs[0].cacheWriteTokens, 0);
  assert.equal(recs[1].inputTokens, 40);
  assert.equal(recs[1].outputTokens, 15);
});

test("skips malformed lines without throwing", () => {
  const text = ["garbage", meta("gpt-5.4"), tc("2026-06-16T18:00:01.000Z", { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 }, { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 })].join("\n");
  const recs = parseCodexTranscript(text);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].model, "gpt-5.4");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/parseCodex.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// usage-history/parseCodex.js
const { localDay } = require("./day");

// Model name appears in session_meta / turn_context payloads (not in token_count).
function extractModel(obj) {
  const p = obj.payload || {};
  if ((obj.type === "session_meta" || obj.type === "turn_context") && typeof p.model === "string") {
    return p.model;
  }
  return null;
}

function parseCodexTranscript(text) {
  const records = [];
  let currentModel = "unknown";

  for (const rawLine of String(text || "").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    const model = extractModel(obj);
    if (model) currentModel = model;

    const p = obj.payload || {};
    if (obj.type !== "event_msg" || p.type !== "token_count") continue;

    const last = (p.info && p.info.last_token_usage) || null;
    const ts = Date.parse(obj.timestamp);
    if (!last || !Number.isFinite(ts)) continue;

    const input = Number(last.input_tokens) || 0;
    const cached = Number(last.cached_input_tokens) || 0;
    const output = Number(last.output_tokens) || 0;

    records.push({
      timestampMs: ts,
      day: localDay(ts),
      cli: "codex",
      model: currentModel,
      inputTokens: Math.max(0, input - cached), // codex input_tokens INCLUDES cached
      cachedReadTokens: cached,
      cacheWriteTokens: 0,
      outputTokens: output
    });
  }

  return records;
}

module.exports = { parseCodexTranscript };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/parseCodex.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add usage-history/parseCodex.js test/parseCodex.test.js
git commit -m "- Add Codex transcript parser using per-turn token deltas and tracked model"
```

---

## Task 5: Transcript file discovery

**Files:**
- Create: `usage-history/sources.js`
- Test: `test/sources.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/sources.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sources.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// usage-history/sources.js
const fs = require("node:fs");
const path = require("node:path");

function walkJsonl(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

function listClaudeFiles(homeDir) {
  const out = [];
  walkJsonl(path.join(homeDir, ".claude", "projects"), out);
  return out;
}

function listCodexFiles(homeDir) {
  const out = [];
  walkJsonl(path.join(homeDir, ".codex", "sessions"), out);
  walkJsonl(path.join(homeDir, ".codex", "archived_sessions"), out);
  return out;
}

function listAllTranscriptFiles(homeDir) {
  return [
    ...listClaudeFiles(homeDir).map((p) => ({ path: p, cli: "claude" })),
    ...listCodexFiles(homeDir).map((p) => ({ path: p, cli: "codex" }))
  ];
}

module.exports = { listClaudeFiles, listCodexFiles, listAllTranscriptFiles };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sources.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add usage-history/sources.js test/sources.test.js
git commit -m "- Add transcript file discovery for Claude and Codex directories"
```

---

## Task 6: Cache store

**Files:**
- Create: `usage-history/store.js`
- Test: `test/store.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/store.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadCache, saveCache } = require("../usage-history/store");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "um-store-"));

test("returns a fresh cache when no file exists", () => {
  const cache = loadCache(tmpDir());
  assert.deepEqual(cache, { version: 1, files: {} });
});

test("round-trips a saved cache", () => {
  const dir = tmpDir();
  const cache = { version: 1, files: { "/a": { mtimeMs: 1, size: 2, cli: "claude", contribution: {} } } };
  saveCache(dir, cache);
  assert.deepEqual(loadCache(dir), cache);
});

test("returns a fresh cache when the file is corrupt", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "usage-history.json"), "{not json");
  assert.deepEqual(loadCache(dir), { version: 1, files: {} });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// usage-history/store.js
const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "usage-history.json";

function freshCache() {
  return { version: 1, files: {} };
}

function loadCache(dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, FILE_NAME), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || typeof parsed.files !== "object") {
      return freshCache();
    }
    return parsed;
  } catch {
    return freshCache();
  }
}

function saveCache(dataDir, cache) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, FILE_NAME), JSON.stringify(cache));
}

module.exports = { loadCache, saveCache, freshCache, FILE_NAME };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/store.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add usage-history/store.js test/store.test.js
git commit -m "- Add usage-history cache store with corrupt-file recovery"
```

---

## Task 7: Aggregation (contributions, rollup, pricing, incremental scan)

**Files:**
- Create: `usage-history/aggregate.js`
- Test: `test/aggregate.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/aggregate.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  recordsToContribution, contributionForFile, mergeAndPrice, scanUsageHistory
} = require("../usage-history/aggregate");

test("recordsToContribution groups buckets by day and cli::model", () => {
  const recs = [
    { day: "2026-06-16", cli: "claude", model: "claude-opus-4-8", inputTokens: 10, cachedReadTokens: 1, cacheWriteTokens: 2, outputTokens: 3 },
    { day: "2026-06-16", cli: "claude", model: "claude-opus-4-8", inputTokens: 5, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }
  ];
  const c = recordsToContribution(recs);
  assert.deepEqual(c["2026-06-16"]["claude::claude-opus-4-8"], { inputTokens: 15, cachedReadTokens: 1, cacheWriteTokens: 2, outputTokens: 4 });
});

test("contributionForFile picks the parser from the path", () => {
  const claudeText = JSON.stringify({ type: "assistant", timestamp: "2026-06-16T18:00:00.000Z", message: { id: "m1", model: "claude-haiku-4-5", usage: { input_tokens: 4, output_tokens: 2 } } });
  const c = contributionForFile("/home/.claude/projects/p/s.jsonl", claudeText);
  assert.ok(c["2026-06-16"]["claude::claude-haiku-4-5"]);
});

test("mergeAndPrice sums a range and computes dollars + flags unknown models", () => {
  const files = {
    "/f1": { cli: "claude", contribution: { "2026-06-16": { "claude::weird-model": { inputTokens: 1_000_000, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } } }
  };
  const now = new Date(2026, 5, 16, 12, 0, 0).getTime();
  const res = mergeAndPrice(files, { rangeDays: 7, nowMs: now });
  assert.equal(res.range.days.length, 7);
  const today = res.range.days.find((d) => d.day === "2026-06-16");
  assert.equal(today.tokens.input, 1_000_000);
  assert.ok(res.flags.unknownModels.includes("weird-model"));
  assert.ok(res.today.tokens.total >= 1_000_000);
});

test("scanUsageHistory skips unchanged files and recomputes changed ones", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-scan-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "um-scan-data-"));
  const dir = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "s.jsonl");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date(now).toISOString(), message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 10 } } }));

  const first = scanUsageHistory({ homeDir: home, dataDir, nowMs: now, rangeDays: 7 });
  assert.equal(first.today.tokens.input, 100);

  // unchanged second scan returns the same totals
  const second = scanUsageHistory({ homeDir: home, dataDir, nowMs: now, rangeDays: 7 });
  assert.equal(second.today.tokens.input, 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/aggregate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// usage-history/aggregate.js
const fs = require("node:fs");
const { localDay } = require("./day");
const { parseClaudeTranscript } = require("./parseClaude");
const { parseCodexTranscript } = require("./parseCodex");
const { priceRecord } = require("./pricing");
const { listAllTranscriptFiles } = require("./sources");
const { loadCache, saveCache } = require("./store");

const EMPTY = () => ({ inputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });

function addBuckets(target, src) {
  target.inputTokens += src.inputTokens || 0;
  target.cachedReadTokens += src.cachedReadTokens || 0;
  target.cacheWriteTokens += src.cacheWriteTokens || 0;
  target.outputTokens += src.outputTokens || 0;
  return target;
}

function recordsToContribution(records) {
  const contribution = {};
  for (const r of records) {
    const dayMap = (contribution[r.day] = contribution[r.day] || {});
    const key = `${r.cli}::${r.model}`;
    dayMap[key] = addBuckets(dayMap[key] || EMPTY(), r);
  }
  return contribution;
}

function contributionForFile(filePath, text) {
  const records = filePath.includes("/.codex/")
    ? parseCodexTranscript(text)
    : parseClaudeTranscript(text);
  return recordsToContribution(records);
}

function rangeDaysList(rangeDays, nowMs) {
  const days = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    days.push(localDay(nowMs - i * 86_400_000));
  }
  return days;
}

function bucketsWithTotal(b) {
  return {
    input: b.inputTokens, cachedRead: b.cachedReadTokens, cacheWrite: b.cacheWriteTokens,
    output: b.outputTokens, total: b.inputTokens + b.cachedReadTokens + b.cacheWriteTokens + b.outputTokens
  };
}

function mergeAndPrice(files, { rangeDays, nowMs }) {
  const wantDays = new Set(rangeDaysList(rangeDays, nowMs));
  const todayKey = localDay(nowMs);
  const unknownModels = new Set();

  // dayKey -> "cli::model" -> buckets
  const byDay = {};
  for (const entry of Object.values(files)) {
    for (const [day, models] of Object.entries(entry.contribution || {})) {
      if (!wantDays.has(day)) continue;
      const into = (byDay[day] = byDay[day] || {});
      for (const [key, buckets] of Object.entries(models)) {
        into[key] = addBuckets(into[key] || EMPTY(), buckets);
      }
    }
  }

  const sumBuckets = (acc, b) => addBuckets(acc, b);
  const priceKey = (key, buckets) => {
    const [cli, ...rest] = key.split("::");
    const model = rest.join("::");
    const p = priceRecord(cli, model, buckets);
    if (!p.modelKnown) unknownModels.add(model);
    return { cli, model, ...p };
  };

  const dayRows = rangeDaysList(rangeDays, nowMs).map((day) => {
    const models = byDay[day] || {};
    const dayTotals = EMPTY();
    const byCli = { claude: { buckets: EMPTY(), dollars: 0 }, codex: { buckets: EMPTY(), dollars: 0 } };
    let dollars = 0;
    for (const [key, buckets] of Object.entries(models)) {
      const priced = priceKey(key, buckets);
      sumBuckets(dayTotals, buckets);
      dollars += priced.dollars;
      if (byCli[priced.cli]) { sumBuckets(byCli[priced.cli].buckets, buckets); byCli[priced.cli].dollars += priced.dollars; }
    }
    return {
      day, tokens: bucketsWithTotal(dayTotals), dollars,
      byCli: { claude: { tokens: bucketsWithTotal(byCli.claude.buckets), dollars: byCli.claude.dollars },
               codex: { tokens: bucketsWithTotal(byCli.codex.buckets), dollars: byCli.codex.dollars } }
    };
  });

  // range model breakdown
  const modelAcc = {};
  const rangeTotals = EMPTY();
  let rangeDollars = 0;
  for (const day of rangeDaysList(rangeDays, nowMs)) {
    for (const [key, buckets] of Object.entries(byDay[day] || {})) {
      const priced = priceKey(key, buckets);
      sumBuckets(rangeTotals, buckets);
      rangeDollars += priced.dollars;
      const m = (modelAcc[key] = modelAcc[key] || { cli: priced.cli, model: priced.model, buckets: EMPTY(), dollars: 0, modelKnown: priced.modelKnown });
      sumBuckets(m.buckets, buckets); m.dollars += priced.dollars;
    }
  }
  const byModel = Object.values(modelAcc)
    .map((m) => ({ cli: m.cli, model: m.model, tokens: bucketsWithTotal(m.buckets), dollars: m.dollars, modelKnown: m.modelKnown }))
    .sort((a, b) => b.dollars - a.dollars);

  const todayRow = dayRows.find((d) => d.day === todayKey) || { tokens: bucketsWithTotal(EMPTY()), dollars: 0, byCli: { claude: { tokens: bucketsWithTotal(EMPTY()), dollars: 0 }, codex: { tokens: bucketsWithTotal(EMPTY()), dollars: 0 } } };

  return {
    today: { tokens: todayRow.tokens, dollars: todayRow.dollars, byCli: todayRow.byCli },
    range: { tokens: bucketsWithTotal(rangeTotals), dollars: rangeDollars, days: dayRows, byModel },
    flags: { unknownModels: Array.from(unknownModels) },
    scannedAt: new Date(nowMs).toISOString()
  };
}

function scanUsageHistory({ homeDir, dataDir, nowMs = Date.now(), rangeDays = 30 }) {
  const cache = loadCache(dataDir);
  const found = listAllTranscriptFiles(homeDir);
  const foundPaths = new Set(found.map((f) => f.path));

  // drop deleted files
  for (const p of Object.keys(cache.files)) {
    if (!foundPaths.has(p)) delete cache.files[p];
  }

  for (const { path: p, cli } of found) {
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    const cached = cache.files[p];
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
    let text = "";
    try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
    cache.files[p] = { mtimeMs: stat.mtimeMs, size: stat.size, cli, contribution: contributionForFile(p, text) };
  }

  saveCache(dataDir, cache);
  return mergeAndPrice(cache.files, { rangeDays, nowMs });
}

module.exports = { recordsToContribution, contributionForFile, mergeAndPrice, scanUsageHistory };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/aggregate.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all existing + new tests PASS.

- [ ] **Step 6: Commit**

```bash
git add usage-history/aggregate.js test/aggregate.test.js
git commit -m "- Add usage-history aggregation: incremental scan, daily rollup, range pricing"
```

---

## Task 8: Backend wiring (Electron IPC + HTTP route)

**Files:**
- Modify: `electron-main.js` (require the module near other requires ~line 1-20; register handler inside `registerIpcHandlers()` near `rate-limit:move-top-right`)
- Modify: `server.js` (add a route alongside the existing `/api/*` routes)
- Modify: `preload.js` (expose `getUsageHistory`)

- [ ] **Step 1: Add the IPC handler in `electron-main.js`**

Near the top requires, add:
```js
const { scanUsageHistory } = require("./usage-history/aggregate");
```
Inside `registerIpcHandlers()`, after the `rate-limit:move-top-right` line, add:
```js
  ipcMain.handle("usage-history:get", (event, options = {}) => {
    const rangeDays = [7, 30, 90].includes(Number(options.rangeDays)) ? Number(options.rangeDays) : 30;
    return scanUsageHistory({ homeDir: os.homedir(), dataDir: appDataDir, rangeDays });
  });
```
(`os` and `appDataDir` already exist in this file.)

- [ ] **Step 2: Expose it in `preload.js`**

After the `moveToTopRight` line:
```js
  getUsageHistory: (options) => ipcRenderer.invoke("usage-history:get", options),
```

- [ ] **Step 3: Add the HTTP route in `server.js`**

Find where `/api/refresh` or `/api/state` routes are registered (search `app.post("/api/` / `app.get("/api/`). Add near them, reusing the existing token-guard middleware those routes use:
```js
  app.get("/api/usage-history", (req, res) => {
    const rangeDays = [7, 30, 90].includes(Number(req.query.rangeDays)) ? Number(req.query.rangeDays) : 30;
    try {
      const { scanUsageHistory } = require("./usage-history/aggregate");
      const os = require("node:os");
      res.json(scanUsageHistory({ homeDir: os.homedir(), dataDir: appDataDir, rangeDays }));
    } catch (error) {
      res.status(500).json({ error: error.message || "Failed to read usage history." });
    }
  });
```
(Confirm `appDataDir` is in scope in `server.js`; if it is named differently, match the existing constant used for `~/.rate-limit-tool`.)

- [ ] **Step 4: Smoke-test the backend headlessly**

Run:
```bash
node -e "const {scanUsageHistory}=require('./usage-history/aggregate'); const os=require('os'); const r=scanUsageHistory({homeDir:os.homedir(),dataDir:require('path').join(os.homedir(),'.rate-limit-tool'),rangeDays:7}); console.log('today tokens:', r.today.tokens.total, '$', r.today.dollars.toFixed(2)); console.log('models:', r.range.byModel.slice(0,4).map(m=>m.model));"
```
Expected: prints a non-negative today token total, a dollar figure, and a few real model ids from your machine.

- [ ] **Step 5: Commit**

```bash
git add electron-main.js preload.js server.js
git commit -m "- Wire usage-history scan into Electron IPC and the browser-mode HTTP route"
```

---

## Task 9: Dashboard window + popover button

**Files:**
- Modify: `electron-main.js` (add `openHistoryWindow()` + IPC `usage-history:open`; create a second BrowserWindow loading `public/history.html`)
- Modify: `preload.js` (expose `openHistory`)
- Modify: `public/index.html` (add the button to the header/footer of the popover)
- Modify: `public/app.js` (wire the button click to `nativeApi.openHistory()`)

- [ ] **Step 1: Add window management in `electron-main.js`**

Near the other window globals (where `popover` is declared), add:
```js
let historyWindow = null;
```
Add a function near `showPopover()`:
```js
function openHistoryWindow() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.show();
    historyWindow.focus();
    return;
  }
  historyWindow = new BrowserWindow({
    width: 720,
    height: 560,
    title: "Usage History",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  historyWindow.loadFile(path.join(__dirname, "public", "history.html"));
  historyWindow.on("closed", () => { historyWindow = null; });
}
```
Inside `registerIpcHandlers()`:
```js
  ipcMain.on("usage-history:open", openHistoryWindow);
```

- [ ] **Step 2: Expose `openHistory` in `preload.js`**

```js
  openHistory: () => ipcRenderer.send("usage-history:open"),
```

- [ ] **Step 3: Add the button to `public/index.html`**

Inside `<main class="widget-shell">`, after the `<section id="accounts">` element, add:
```html
      <button id="history-button" class="history-button">View usage history →</button>
```

- [ ] **Step 4: Wire the button in `public/app.js`**

Near the `refreshButton`/header dblclick listeners, add:
```js
document.querySelector("#history-button")?.addEventListener("click", () => {
  nativeApi?.openHistory?.();
});
```
Bump the cache-buster versions in `public/index.html` (`styles.css?v=` and `app.js?v=`) to a new value.

- [ ] **Step 5: Add minimal button style in `public/styles.css`**

```css
.history-button {
  width: 100%;
  margin-top: 6px;
  background: var(--surface);
  color: var(--muted);
  -webkit-app-region: no-drag;
}
.history-button:hover { color: var(--fg); }
```

- [ ] **Step 6: Manual check**

Run: `npm start`, click "View usage history →". Expected: a 720×560 window opens (blank until Task 10). Close it; confirm the popover still works.

- [ ] **Step 7: Commit**

```bash
git add electron-main.js preload.js public/index.html public/app.js public/styles.css
git commit -m "- Add dashboard window plumbing and a popover button to open usage history"
```

---

## Task 10: Dashboard frontend

**Files:**
- Create: `public/history.html`
- Create: `public/history.js`
- Modify: `public/styles.css` (append dashboard styles)

- [ ] **Step 1: Create `public/history.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'" />
    <title>Usage History</title>
    <link rel="stylesheet" href="styles.css?v=20260616a" />
  </head>
  <body class="history-body">
    <header class="history-header">
      <h1>Usage History</h1>
      <div class="range-toggle">
        <button data-range="7">7d</button>
        <button data-range="30" class="active">30d</button>
        <button data-range="90">90d</button>
      </div>
    </header>
    <section class="history-summary">
      <div class="card"><span class="card-label">Today</span><span id="today-tokens" class="card-value">–</span><span id="today-dollars" class="card-sub">–</span></div>
      <div class="card"><span class="card-label">Range total</span><span id="range-tokens" class="card-value">–</span><span id="range-dollars" class="card-sub">–</span></div>
      <div class="card"><span class="card-label">Claude / Codex</span><span id="cli-split" class="card-value">–</span></div>
    </section>
    <section id="chart" class="history-chart" aria-label="Tokens per day"></section>
    <section class="history-models"><table id="model-table"><thead><tr><th>Model</th><th>CLI</th><th>Tokens</th><th>$ API-value</th></tr></thead><tbody></tbody></table></section>
    <p id="history-note" class="history-note"></p>
    <script src="history.js?v=20260616a" type="module"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `public/history.js`**

```js
const nativeApi = window.rateLimitAPI || null;
let rangeDays = 30;

const fmtTokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
const fmtDollars = (n) => "$" + (Number(n) || 0).toFixed(2);

async function load() {
  if (!nativeApi?.getUsageHistory) return;
  const data = await nativeApi.getUsageHistory({ rangeDays });
  render(data);
}

function render(data) {
  document.querySelector("#today-tokens").textContent = fmtTokens(data.today.tokens.total) + " tok";
  document.querySelector("#today-dollars").textContent = fmtDollars(data.today.dollars);
  document.querySelector("#range-tokens").textContent = fmtTokens(data.range.tokens.total) + " tok";
  document.querySelector("#range-dollars").textContent = fmtDollars(data.range.dollars);

  const claude = data.range.days.reduce((s, d) => s + d.byCli.claude.tokens.total, 0);
  const codex = data.range.days.reduce((s, d) => s + d.byCli.codex.tokens.total, 0);
  document.querySelector("#cli-split").textContent = `${fmtTokens(claude)} / ${fmtTokens(codex)}`;

  renderChart(data.range.days);

  const tbody = document.querySelector("#model-table tbody");
  tbody.innerHTML = "";
  for (const m of data.range.byModel) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${m.model}${m.modelKnown ? "" : " *"}</td><td>${m.cli}</td><td>${fmtTokens(m.tokens.total)}</td><td>${fmtDollars(m.dollars)}</td>`;
    tbody.appendChild(tr);
  }
  document.querySelector("#history-note").textContent =
    data.flags.unknownModels.length ? `* unknown model, priced at fallback rate: ${data.flags.unknownModels.join(", ")}` : "";
}

function renderChart(days) {
  const W = 680, H = 200, pad = 24;
  const max = Math.max(1, ...days.map((d) => d.tokens.total));
  const bw = (W - pad * 2) / days.length;
  const bar = (d, i) => {
    const x = pad + i * bw;
    const ch = ((d.byCli.claude.tokens.total) / max) * (H - pad * 2);
    const co = ((d.byCli.codex.tokens.total) / max) * (H - pad * 2);
    const base = H - pad;
    return `<rect x="${x + 1}" y="${base - ch}" width="${bw - 2}" height="${ch}" fill="#f4ab5e"></rect>` +
           `<rect x="${x + 1}" y="${base - ch - co}" width="${bw - 2}" height="${co}" fill="#74c278"></rect>`;
  };
  document.querySelector("#chart").innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${days.map(bar).join("")}</svg>` +
    `<div class="legend"><span class="dot claude"></span>Claude <span class="dot codex"></span>Codex</div>`;
}

for (const btn of document.querySelectorAll(".range-toggle button")) {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    rangeDays = Number(btn.dataset.range);
    load();
  });
}

load();
```

- [ ] **Step 3: Append dashboard styles to `public/styles.css`**

```css
.history-body { padding: 14px 16px; color: var(--fg); background: var(--bg); font-family: "Avenir Next", sans-serif; }
.history-header { display: flex; justify-content: space-between; align-items: center; }
.range-toggle button { margin-left: 4px; }
.range-toggle button.active { color: var(--fg); border-color: var(--accent); }
.history-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 12px 0; }
.card { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.card-label { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim); }
.card-value { font-size: 1.1rem; font-weight: 700; }
.card-sub { font-size: 0.8rem; color: var(--muted); }
.history-chart { margin: 8px 0; }
.history-chart .legend { font-size: 0.7rem; color: var(--muted); }
.history-chart .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin: 0 4px 0 10px; }
.history-chart .dot.claude { background: #f4ab5e; }
.history-chart .dot.codex { background: #74c278; }
.history-models table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
.history-models th, .history-models td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--line); }
.history-note { font-size: 0.7rem; color: var(--muted); }
```

- [ ] **Step 4: Commit**

```bash
git add public/history.html public/history.js public/styles.css
git commit -m "- Add usage history dashboard UI with daily bar chart and per-model breakdown"
```

---

## Task 11: End-to-end verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (existing 18 + new ~17).

- [ ] **Step 2: Launch and exercise the dashboard**

Run: `npm start`. Click "View usage history →". Confirm:
- Today + range cards show real token/dollar numbers.
- The bar chart renders one stacked bar per day (Claude orange, Codex green).
- The model table lists your real models with dollar values; any unknown model shows a `*` note.
- Switching 7d / 30d / 90d reloads the data.

- [ ] **Step 3: Verify the numbers against the source (sanity check)**

Compare today's Codex token total against the last `total_token_usage` in today's `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` files; they should be in the same ballpark. Note any large discrepancy for investigation.

- [ ] **Step 4: Final commit (cache-buster bump if not already done)**

```bash
git add -A
git commit -m "- Finalize usage history tracker end-to-end"
```

---

## Self-review notes

- **Spec coverage:** transcript sources (Task 5), Claude/Codex parsers (3,4), normalized records (3,4), local-day bucketing (2), incremental cache (6,7), pricing/API-equivalent dollars (1,7), backend contract (8), dashboard window + button (9), chart + model breakdown (10), error handling (parsers skip bad lines; store recovers from corrupt; unknown-model flag in 1/7/10), tests (every module). 
- **Pricing numbers:** confirm against the `claude-api` skill (Claude) and current OpenAI pricing (Codex) when implementing Task 1; `pricing.js` is the single edit point.
- **Type consistency:** `Buckets` = `{inputTokens, cachedReadTokens, cacheWriteTokens, outputTokens}` everywhere; response token objects use `{input, cachedRead, cacheWrite, output, total}` via `bucketsWithTotal`; cli::model key format is consistent across `recordsToContribution`, `mergeAndPrice`, and the parsers.
