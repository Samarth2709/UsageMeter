# Usage History Tracker — Design

> **Historical document — superseded.** This was the approved June 16 design proposal. The tracker shipped and has since evolved; use the active [Architecture](../ARCHITECTURE.md) and [Project history](../HISTORY.md) instead.

Date: 2026-06-16
Status: Approved (pending spec review)

## 1. Overview

Add a feature to Usage Meter that tracks Claude and Codex **token usage over time**
from local CLI transcripts, shows tokens used **today** and over **past days**, and
expresses spend as the **API-equivalent dollar value** of those tokens (what the same
usage would cost at pay-as-you-go API rates — i.e. the value extracted from the
subscription).

This is a **separate tracker**, independent of the existing rate-limit view. The
rate-limit endpoints (`chatgpt.com/backend-api/wham/usage`, the `claude /status`
screen) report only *percent of the current window used* and contain **no token
counts**, so they cannot answer "tokens used today." The real token data lives in the
local CLI transcripts, which is the only source this feature uses.

## 2. Goals / Non-goals

**Goals**
- Parse local Claude + Codex transcripts into per-message token records.
- Roll up into **daily totals**, split by **CLI** (Claude vs Codex) and by **model**.
- Show **today** and a configurable **past-N-days** range (7 / 30 / 90).
- Compute **API-equivalent dollars** per day / model / CLI.
- Live in a **dedicated dashboard window**, opened from the existing popover.

**Non-goals (explicitly out of scope)**
- No live token streaming or real-time per-message updates.
- No changes to the rate-limit window view (only a button is added to the popover).
- No charting library (charts are hand-rolled SVG).
- No per-chat / per-session drilldown (daily + CLI/model split only).
- No editing or uploading of transcripts; read-only consumption.

## 3. Data sources & on-disk formats (verified 2026-06-16)

### 3.1 Claude Code
- Location: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
- One JSON object per line. Assistant messages carry usage:
  - `timestamp` (ISO, line-level)
  - `message.id` (e.g. `msg_…`) and `requestId` (e.g. `req_…`) — used for **dedup**
  - `message.model` (e.g. `claude-opus-4-8`)
  - `message.usage`:
    - `input_tokens` — fresh (non-cached) input
    - `cache_read_input_tokens` — cache hits (separate from input_tokens)
    - `cache_creation_input_tokens` — cache writes (separate; has `ephemeral_1h`/`ephemeral_5m` breakdown)
    - `output_tokens`
  - `isSidechain` (bool) — subagent traffic. **Included** (it is real billed usage); recorded so it can be split out later if wanted.
- Dedup: streaming can emit multiple lines for one assistant message; keep one usage
  record per unique `message.id` (fall back to `requestId`).

### 3.2 Codex
- Location: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` plus `~/.codex/archived_sessions/rollout-*.jsonl`
- Relevant events while walking a file in order:
  - `session_meta` / `turn_context` payloads → carry the **model name** and cwd. The
    parser tracks "current model" from the most recent such event.
  - `event_msg` with `payload.type === "token_count"`:
    - `timestamp` (line-level)
    - `payload.info.last_token_usage` — the most recent turn's delta:
      `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`
    - `payload.info.total_token_usage` — cumulative session totals (same shape)
    - `payload.rate_limits` — ignored by this feature
- Per-turn delta = `last_token_usage` (one record per `token_count` event, timestamped).
- **Reconciliation guard:** the summed per-turn deltas for a session must equal the
  final `total_token_usage`. If they diverge (e.g. missed events), trust
  `total_token_usage` and attribute the remainder to the last observed day.
- Field semantics (confirmed): `total_tokens = input_tokens + output_tokens`;
  `cached_input_tokens ⊆ input_tokens`; `reasoning_output_tokens ⊆ output_tokens`.

## 4. Architecture & modules

Self-contained `usage-history/` directory; nothing in the existing rate-limit path
changes except adding one popover button + one IPC/route.

- `usage-history/sources.js` — enumerate transcript files for each CLI. Missing dir →
  empty list (CLI simply absent).
- `usage-history/parseClaude.js` — `(fileText) → TokenRecord[]`. Dedup by `message.id`.
- `usage-history/parseCodex.js` — `(fileText) → TokenRecord[]`. Tracks current model;
  emits one record per `token_count` event; reconciles against `total_token_usage`.
- `usage-history/pricing.js` — pure `(cli, model, buckets) → { dollars, modelKnown }`.
- `usage-history/aggregate.js` — incremental file cache + daily rollup (§6).
- `usage-history/store.js` — read/write `~/.rate-limit-tool/usage-history.json`
  (reuses the app's existing data dir, `appDataDir`).

## 5. Normalized data model

```
TokenRecord = {
  timestampMs: number,     // line timestamp
  day: "YYYY-MM-DD",       // LOCAL-timezone calendar day of timestampMs
  cli: "claude" | "codex",
  model: string,           // raw model id as found
  inputTokens: number,     // fresh/uncached input
  cachedReadTokens: number,
  cacheWriteTokens: number, // Claude only; 0 for Codex
  outputTokens: number,    // includes reasoning for Codex
  isSidechain?: boolean    // Claude only
}
```

- **Day boundary = local timezone midnight**, so "today" matches the wall clock.
- Daily aggregate key: `(day, cli, model)` → summed token buckets.

## 6. Incremental storage & rollup

`~/.rate-limit-tool/usage-history.json`:

```
{
  version: 1,
  files: {
    "<absolute file path>": {
      mtimeMs, size,
      contribution: { "<day>": { "<cli>::<model>": {input,cachedRead,cacheWrite,output} } }
    }, ...
  }
}
```

Scan algorithm:
1. Enumerate current transcript files via `sources.js`.
2. For each file: if `mtimeMs` & `size` match the cache, **skip**. Otherwise **fully
   re-parse** that one file and replace its `contribution` slice (no byte offsets →
   no double-count, robust to rewrites).
3. Drop cache entries for files that no longer exist.
4. Daily aggregate for a query = sum of all files' `contribution` over the requested
   date range.

First run = one-time full parse (dashboard shows a loading state). Afterward only the
active/changed session files are re-read, so scans stay fast.

## 7. Pricing model (API-equivalent dollars)

Rate table in `pricing.js`, the single place to edit, keyed by normalized model →
USD per 1M tokens. Normalization maps raw ids to a rate key (e.g. `claude-opus-4-8[1m]`
→ `claude-opus`, `gpt-5.5-codex` → `gpt-5.5`). Unknown model → a documented fallback
rate **and** `modelKnown:false` surfaced in the response (never a silent $0).

Initial table (USD / 1M tokens; verify Claude rates via the `claude-api` skill and
Codex rates via current OpenAI pricing at implementation time):

| Rate key      | input | cached read | cache write | output |
|---------------|-------|-------------|-------------|--------|
| claude-fable  | 10.00 | 1.00        | 12.50       | 50.00  |
| claude-opus   | 5.00  | 0.50        | 6.25        | 25.00  |
| claude-sonnet | 3.00  | 0.30        | 3.75        | 15.00  |
| claude-haiku  | 1.00  | 0.10        | 1.25        | 5.00   |
| gpt-5.5       | 5.00  | 0.50        | —           | 30.00  |
| gpt-5.4       | 2.50  | 0.25        | —           | 15.00  |
| _fallback_    | 3.00  | 0.30        | 3.75        | 15.00  |

Claude rates verified against the `claude-api` skill (Models table, 2026-06):
Fable 5 $10/$50, Opus 4.x $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5; cache read
= 0.1× input, cache write = 1.25× input (5-minute ephemeral default).

Cost formulas (per record, reflecting the differing field semantics):
- **Claude:** `input×in + cachedRead×cacheRead + cacheWrite×cacheWrite + output×out`
- **Codex:** `(input − cachedInput)×in + cachedInput×cachedRead + output×out`
  (Codex `input_tokens` includes cached; no separate cache-write; reasoning is within output.)

Cache-write rate refinement (optional, later): use Claude's `ephemeral_1h` (2× input)
vs `ephemeral_5m` (1.25× input) split instead of a flat 1.25×.

## 8. Backend API contract

One call, exposed two ways (Electron IPC `usage-history:get` + HTTP route in
`server.js` for `npm run server` browser mode):

Request: `{ rangeDays: 7 | 30 | 90 }`
Response:
```
{
  today:  { tokens, dollars, byCli: {...}, byModel: [...] },
  range:  { tokens, dollars, days: [ { day, tokens, dollars, byCli, byModel } ... ] },
  flags:  { unknownModels: [ "<raw id>", ... ] },
  scannedAt: ISO
}
```
Token figures expose the buckets (input/cachedRead/cacheWrite/output) plus a total.

## 9. Dashboard window (frontend)

- New frameless `BrowserWindow` (`public/history.html`, `public/history.js`, shared
  styles), opened from a **"View usage history →"** button added to the popover.
- Layout:
  - Range toggle: `7d | 30d | 90d`.
  - **Tokens-per-day bar chart**, hand-rolled SVG (no chart dependency, matching the
    app's existing zero-chart-dep style); one bar per day, **stacked by CLI** (Claude
    and Codex segments in distinct colors).
  - **Today** card: total tokens + API-equivalent `$`.
  - **Claude vs Codex** split for the range.
  - **Per-model** breakdown table (tokens + `$`), with an "unknown model" note when
    `flags.unknownModels` is non-empty.
- Refresh on open and via a manual refresh control; reuses the existing dark styling.

## 10. Error handling

- Malformed JSONL line → skip the line, continue parsing the file.
- Missing CLI directory → that source contributes nothing.
- Unknown model → fallback rate + flagged in `flags.unknownModels`.
- Corrupt cache file → discard and rebuild from scratch.
- First-run/large scans → dashboard shows a loading state; no UI block.

## 11. Testing (repo `node --test` style, fabricated fixtures)

- `parseClaude`: token extraction, `message.id` dedup, sidechain inclusion, model capture.
- `parseCodex`: per-turn `last_token_usage` deltas, model tracking across `turn_context`,
  reconciliation vs `total_token_usage`.
- `pricing`: known token buckets → known dollars, per-CLI formula correctness, fallback flag.
- `aggregate`: unchanged file skipped; changed file recomputes only its slice; deleted
  file drops out; range rollup sums correctly.
- Day bucketing: timestamps near local midnight land in the correct local day.

## 12. File layout (new)

```
usage-history/
  sources.js
  parseClaude.js
  parseCodex.js
  pricing.js
  aggregate.js
  store.js
public/
  history.html
  history.js
test/
  parseClaude.test.js
  parseCodex.test.js
  pricing.test.js
  aggregate.test.js
```
Touched existing files: `electron-main.js` (new window + IPC), `server.js` (HTTP route),
`preload.js` (open-dashboard bridge), `public/app.js` + `public/index.html` (popover button).

## 13. Resolved decisions

- Source = local transcripts only; separate from rate-limit view. ✅
- Dollars = API-equivalent value. ✅
- UI = dedicated dashboard window opened from popover. ✅
- Detail = daily totals split by CLI and model. ✅
- Day boundary = local timezone.
- Codex per-turn = `last_token_usage`, reconciled to `total_token_usage`.
- Sidechain (Claude subagent) usage included.
