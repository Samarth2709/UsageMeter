# Architecture

Usage Meter has two local surfaces: an Electron menu-bar app and a static marketing/demo site. The app gets live allowance data and local transcript analytics; the site has no credentials and uses mock data.

## Components

| Area | Main files | Responsibility |
| --- | --- | --- |
| Fixed Electron shell | `bootstrap.js`, `bootstrap-updater.js`, `core-updater.js`, `atomic-file.js`, `preload.js` | Single-instance admission, Core selection, signed update verification, rollback, durable private state writes, stable update IPC, and manual shell-download fallback. |
| Versioned Core | `electron-main.js`, `server.js`, `usage-windows.js`, `usage-history/`, `public/`, `assets/` | Tray icon, popover/history windows, live refresh, local analytics, and app UI. |
| Live limits | `electron-main.js`, `server.js`, `usage-windows.js` | Authenticated Claude web usage, Codex usage requests, identity/config storage, window normalization, caching, and merging. |
| Usage History | `usage-history/` | Incremental transcript indexing, aggregation, pricing, diagnostics, subscription value, and model insights. Index work runs in a short-lived Electron utility process. |
| App renderer | `public/` | Menu-bar popover and Usage History dashboard. |
| Static site | `site/` | Marketing page and credential-free dashboard demo driven by `site/mock.js`. |
| Tests | `test/` | Node tests for parsing, cache behavior, limits, UI lifecycle helpers, and analytics. |

`pricing.js` at the repository root intentionally re-exports `usage-history/pricing.js`; the latter is the canonical pricing table.

## Runtime data flow

```text
Existing Codex authentication + authenticated Claude web session
  -> server.js refreshes Codex and electron-main.js refreshes Claude allowance windows
  -> electron-main.js caches and broadcasts a snapshot
  -> public/app.js renders the menu-bar popover

Local Claude/Codex .jsonl transcripts
  -> index-worker.js runs outside the menu-bar process
  -> sources.js inventories file metadata
  -> parseClaude.js / parseCodex.js read only new complete JSONL bytes
  -> usage-index.json stores per-file state, daily aggregates, and recent minute buckets
  -> aggregate.js + pricing.js produce compact History results
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
| `usage-index.json` | Canonical version-4 index: file identity/offset/parser state, globally owned Claude message events, retained 90-day CLI/model/project aggregates, and recent minute buckets. Written atomically. |
| `usage-history.json` | Legacy per-file History cache. Imported into `usage-index.json` when compatible; retained for rollback compatibility. |
| `window-points.json` | Legacy recent-point cache. Imported into `usage-index.json` when compatible; retained for rollback compatibility. |
| `window-state.json` | Saved popover position. |
| `automation-state.json` | Optional Codex-only 5-hour automation deduplication state. |
| `cores/current.json` | Atomically written pointer to the active, previous, and pending verified Core. |
| `cores/<version>/` | Verified Core files plus the signed manifest and signature used to activate them. |

Transcript parsing is read-only. The cache stores aggregate buckets plus normalized Claude message usage needed to prevent fork/resume double counting; it does not store raw transcript text or message content.

## Refresh and resilience

- Main snapshots refresh every minute.
- History refreshes start a short-lived utility process for index work, then retain only compact dashboard results in the Electron main process.
- Index updates perform a metadata inventory, read only bytes appended after each file's saved offset, and rebuild a truncated, replaced, reclassified, or indexed-tail-modified file.
- Missing-file reconciliation runs hourly. It retains already-indexed daily aggregates for the 90-day dashboard when a CLI cleans up a transcript, then prunes them after they age out. Unchanged transcript contents are never reread during that pass.
- Daily aggregates retain exact token-type/model/project totals. Claude streaming updates replace partial usage for the same message, and one deterministic owner is selected when a fork or resume copies that message into another transcript. Codex cumulative totals repair token residuals after a damaged JSONL row, while repeated snapshots remain ignored. Recent allowance data is stored in minute buckets and priced when read. A non-minute-aligned start includes its first partial minute, a conservative precision bound of less than 60 seconds.
- Public legacy caches predate the corrected Claude streaming and Codex cumulative-snapshot semantics. Live legacy transcripts are rebuilt once during migration, with compact atomic checkpoints every 1,000 rebuilt files so an interrupted migration resumes instead of starting over; cached 90-day aggregates are retained only when the source transcript has already been cleaned up. Later updates read only appended bytes.
- Duplicate transcript paths keep metadata-only suppression entries outside the aggregate-bearing file map. That prevents late structural deduplication from reparsing unchanged copies; if the primary disappears, a surviving copy is promoted and fully rebuilt before it contributes usage.
- A schema-version mismatch or corrupt canonical index rebuilds from transcripts instead of accepting potentially stale legacy cache data.
- Diagnostics exposes an explicit full index rebuild for an in-place rewrite earlier in an already-indexed prefix, which append-only tail validation cannot detect without rereading the prefix on every refresh. The repair preserves retained 90-day aggregates for transcripts that are no longer present.
- Private JSON state is written with unique temporary files, file and directory sync, restrictive permissions, and atomic rename. Incomplete trailing JSONL is left uncommitted until it becomes a complete valid record.
- Claude allowance refresh is web-only and throttled to avoid repeatedly opening a renderer. Cached values remain visible in a grey `Cached` state when the web source is unavailable.
- Usage History is recomputed only while its window is open. In-memory history data is released when the window closes.
- Aggregate-bearing file entries use device/inode identity, CLI tag, size, byte offset, parser continuation state, and a tail hash. Duplicate entries retain only identity and file metadata. Append-only growth is incremental; replacement/truncation rebuilds only that file.
- Calendar ranges use local dates, not fixed 24-hour jumps, so daylight-saving transitions stay correct.
- Limit windows use provider-reported duration/reset metadata. A weekly-only allowance does not get an invented five-hour window.

## Boundaries and safety

- The static site never receives live account data; it renders the same dashboard structures with mock data.
- The Electron renderer uses IPC rather than direct Node access.
- The browser/debug server protects its API with a session token and is intended for local debugging.
- Usage Meter never launches Claude Code from startup, background refresh, manual refresh, or reset automation. Claude CLI launches are limited to explicit Sign In and Log Out actions.
- Model names and paths derived from transcripts are escaped before renderer insertion. Paths are tooltip-only in the Project Ledger.
- On the first packaged launch from `/Applications`, the app enables the macOS login item once. Source-mode runs and later user opt-outs are left alone.
- The fixed shell fetches a signed GitHub Release manifest. It validates the Ed25519 signature, archive SHA-256, path-safe archive contents, minimum shell version, and an exact signed per-file SHA-256 map before activation and before every later Core launch. Missing, modified, extra, or symlinked Core files are rejected.
- A pending Core is healthy only after its registered popover renderer completes initialization and calls the fixed-preload health IPC. A document load alone cannot clear rollback protection; a Core that never sends that acknowledgement is rolled back on the next launch.
- The bundled Core is a version floor and offline fallback. Routine Core updates stay inside `~/.rate-limit-tool/cores/`; Electron/runtime changes stay in the installed `.app` and require a new DMG. Current DMGs are ad-hoc signed but remain unnotarized until Apple release credentials are configured.

## Keeping app and site aligned

`public/history.js` and `site/history.js` share dashboard behavior. When a dashboard interaction changes, update both deliberately and verify their content hashes or diff. The site can omit native-only controls such as folder editing because it has no Electron IPC.

For implementation commands and validation, see [Development](DEVELOPMENT.md). For publishing behavior, see [Releasing](RELEASING.md).
