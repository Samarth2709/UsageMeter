# Architecture

Usage Meter has two local surfaces: an Electron menu-bar app and a static marketing/demo site. The app gets live allowance data and local transcript analytics; the site has no credentials and uses mock data.

## Components

| Area | Main files | Responsibility |
| --- | --- | --- |
| Fixed Electron shell | `bootstrap.js`, `bootstrap-updater.js`, `core-updater.js`, `preload.js` | Core selection, signed update verification, rollback, stable update IPC, and manual shell-download fallback. |
| Versioned Core | `electron-main.js`, `server.js`, `usage-windows.js`, `usage-history/`, `public/`, `assets/` | Tray icon, popover/history windows, live refresh, local analytics, and app UI. |
| Live limits | `server.js`, `usage-windows.js` | Identity/config storage, Codex usage requests, Claude CLI/web usage capture, window normalization and merging. |
| Usage History | `usage-history/` | Incremental transcript indexing, aggregation, pricing, diagnostics, runway, and model insights. Index work runs in a short-lived Electron utility process. |
| App renderer | `public/` | Menu-bar popover and Usage History dashboard. |
| Static site | `site/` | Marketing page and credential-free dashboard demo driven by `site/mock.js`. |
| Tests | `test/` | Node tests for parsing, cache behavior, limits, UI lifecycle helpers, and analytics. |

`pricing.js` at the repository root intentionally re-exports `usage-history/pricing.js`; the latter is the canonical pricing table.

## Runtime data flow

```text
Existing Codex/Claude CLI authentication
  -> server.js refreshes live allowance windows
  -> electron-main.js caches and broadcasts a snapshot
  -> public/app.js renders the menu-bar popover

Local Claude/Codex .jsonl transcripts
  -> index-worker.js runs outside the menu-bar process
  -> sources.js inventories file metadata
  -> parseClaude.js / parseCodex.js read only new complete JSONL bytes
  -> usage-index.json stores per-file state, daily aggregates, and recent minute buckets
  -> aggregate.js + pricing.js produce compact History/runway results
  -> public/history.js renders the Usage History dashboard
```

The dashboard has 7-, 30-, and 90-day ranges. It combines daily usage with live allowance windows, but clearly distinguishes live, window-scoped values from range-scoped history.

## Local sources and storage

Default transcript roots:

- Claude Code: `~/.claude/projects`, or `CLAUDE_CONFIG_DIR/projects` when overridden.
- Codex: `~/.codex/sessions` and archived sessions; `CODEX_HOME`; app-managed Codex identity homes; and the known Orca runtime home.
- Extra Claude and Codex roots: configured in the dashboard's Diagnostics page. They are additive and scanned recursively for `.jsonl` files.

The app's local state is under `~/.rate-limit-tool/`:

| Path | Purpose |
| --- | --- |
| `accounts.json` | Identity metadata and configured extra transcript roots. |
| `codex-identities/` | Per-identity Codex home/auth state. |
| `usage-index.json` | Canonical version-3 index: file identity/offset/parser state, retained 90-day CLI/model/project aggregates, and recent minute buckets. Written atomically. |
| `usage-history.json` | Legacy per-file History cache. Imported into `usage-index.json` when compatible; retained for rollback compatibility. |
| `window-points.json` | Legacy recent-point cache. Imported into `usage-index.json` when compatible; retained for rollback compatibility. |
| `window-state.json` | Saved popover position. |
| `runway-alert-state.json` | Per-window/reset alert records used to avoid duplicate forecast notifications. |
| `runway-evaluation-state.json` | Active allowance observations and first/latest predictions used to match outcomes across restarts. |
| `runway-evaluations.jsonl` | Append-only prediction, first-observed limit-hit, and unmatched-reset events for later accuracy analysis. |
| `automation-state.json` | Optional 5-hour automation deduplication state. |
| `cores/current.json` | Atomically written pointer to the active, previous, and pending verified Core. |
| `cores/<version>/` | Verified Core files plus the signed manifest and signature used to activate them. |

Transcript parsing is read-only. The cache stores aggregated contributions, not a copy of the raw transcript text.

## Runway evaluation log

Runway evaluation is observational and does not alter the forecast. For each unambiguous allowance, the app records an actionable prediction when it first appears, every 15 minutes while it remains actionable, or when its predicted limit-reached time moves by at least five minutes. Each prediction includes the forecast version, prediction horizon, used and estimated remaining tokens, allowance percentage, seven-day token pace, active-day count, and provider-reported reset.

An actual limit hit is recorded only from a fresh provider observation at or above 100%. `actualLimitReachedAt` is therefore the first observed hit, not a falsely precise provider event timestamp. `lastBelowLimitAt` and `observationIntervalMinutes` preserve the polling uncertainty. `predictionErrorMinutes` is actual minus predicted, so a positive value means the limit was first observed later than predicted and a negative value means it was observed earlier.

If a tracked allowance resets without a hit being observed, the log records `window_closed` with `outcome: "not_observed_before_reset"` and a null actual time. This is a censored/unmatched outcome, not evidence that the limit was never reached. Stale provider snapshots and ambiguous multi-account services are excluded.

## Refresh and resilience

- Main snapshots refresh every minute.
- Each refresh starts a short-lived utility process for index work, then retains only compact runway/History results in the Electron main process.
- Index updates perform a metadata inventory, read only bytes appended after each file's saved offset, and rebuild a truncated, replaced, reclassified, or indexed-tail-modified file.
- Missing-file reconciliation runs hourly. It retains already-indexed daily aggregates for the 90-day dashboard when a CLI cleans up a transcript, then prunes them after they age out. Unchanged transcript contents are never reread during that pass.
- Daily aggregates retain exact token-type/model/project totals. Claude streaming updates replace partial usage for the same message, and repeated Codex cumulative snapshots are ignored. Recent allowance/runway data is stored in minute buckets and priced when read. A non-minute-aligned start includes its first partial minute, a conservative precision bound of less than 60 seconds.
- Public legacy caches predate the corrected Claude streaming and Codex cumulative-snapshot semantics. Live legacy transcripts are rebuilt once during migration; cached 90-day aggregates are retained only when the source transcript has already been cleaned up. Later updates read only appended bytes.
- Duplicate transcript paths keep metadata-only suppression entries outside the aggregate-bearing file map. That prevents late structural deduplication from reparsing unchanged copies; if the primary disappears, a surviving copy is promoted and fully rebuilt before it contributes usage.
- A schema-version mismatch or corrupt canonical index rebuilds from transcripts instead of accepting potentially stale legacy cache data.
- Diagnostics exposes an explicit full index rebuild for an in-place rewrite earlier in an already-indexed prefix, which append-only tail validation cannot detect without rereading the prefix on every refresh. The repair preserves retained 90-day aggregates for transcripts that are no longer present.
- Index writes use a temporary file plus atomic rename. Incomplete trailing JSONL is left uncommitted until it becomes a complete valid record.
- Claude CLI and web refreshes are throttled to avoid repeatedly opening a renderer or pseudo-terminal.
- Usage History is recomputed only while its window is open. In-memory history data is released when the window closes.
- Runway forecasts use one rolling seven-day calendar pace, including breaks.
- Runway evaluation state is written atomically after successful refreshes; its append-only log uses deterministic event IDs so duplicate recovery records can be identified.
- Aggregate-bearing file entries use device/inode identity, CLI tag, size, byte offset, parser continuation state, and a tail hash. Duplicate entries retain only identity and file metadata. Append-only growth is incremental; replacement/truncation rebuilds only that file.
- Calendar ranges use local dates, not fixed 24-hour jumps, so daylight-saving transitions stay correct.
- Limit windows use provider-reported duration/reset metadata. A weekly-only allowance does not get an invented five-hour window.

## Boundaries and safety

- The static site never receives live account data; it renders the same dashboard structures with mock data.
- The Electron renderer uses IPC rather than direct Node access.
- The browser/debug server protects its API with a session token and is intended for local debugging.
- Model names and paths derived from transcripts are escaped before renderer insertion. Paths are tooltip-only in the Project Ledger.
- On the first packaged launch from `/Applications`, the app enables the macOS login item once. Source-mode runs and later user opt-outs are left alone.
- The fixed shell fetches a signed GitHub Release manifest. It validates the Ed25519 signature, archive SHA-256, path-safe archive contents, minimum shell version, and an exact signed per-file SHA-256 map before activation and before every later Core launch. Missing, modified, extra, or symlinked Core files are rejected.
- A pending Core is healthy only after its registered popover renderer completes initialization and calls the fixed-preload health IPC. A document load alone cannot clear rollback protection; a Core that never sends that acknowledgement is rolled back on the next launch.
- The bundled Core is the offline fallback. Routine Core updates stay inside `~/.rate-limit-tool/cores/`; Electron/runtime changes stay in the installed `.app` and require a new DMG while the app is unsigned.

## Keeping app and site aligned

`public/history.js` and `site/history.js` share dashboard behavior. When a dashboard interaction changes, update both deliberately and verify their content hashes or diff. The site can omit native-only controls such as folder editing because it has no Electron IPC.

For implementation commands and validation, see [Development](DEVELOPMENT.md). For publishing behavior, see [Releasing](RELEASING.md).
