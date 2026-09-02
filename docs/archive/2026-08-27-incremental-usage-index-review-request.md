# Usage Index Review Request

> **Historical review brief — completed and superseded.** Preserved for provenance; use [Architecture](../ARCHITECTURE.md) for the current design.

## Scope

Review the point-in-time uncommitted diff in the Usage Meter repository against
the [incremental usage index plan](2026-08-27-incremental-usage-index-plan.md).
This is a read-only review: do not edit files.

Base commit: `f7d5e61afdd326bfa818f9bf2bc8d588bb9ee32a`

## What changed

- Added a version-3 `usage-index.json` with per-file identity, processed byte
  offset, parser continuation state, daily aggregates, project aggregates, and
  recent minute buckets.
- Added append-only JSONL parsing for Codex and Claude, including partial-line
  handling and per-file fallback rebuilds for truncation/replacement.
- Added migration from the existing `usage-history.json` and
  `window-points.json` caches.
- Moved background indexing/runway and History payload work into serialized,
  short-lived Electron utility processes.
- Removed duplicate recent-point construction from runway calculation.
- Added focused regression tests and architecture documentation.

## Required review

Prioritize actionable correctness issues:

1. Incremental parser state and duplicate/missing usage risks.
2. File replacement, truncation, partial writes, migration, deletion, and
   atomic-write behavior.
3. Window/runway accuracy with conservative minute-boundary inclusion.
4. Electron utility-process spawn, message, timeout, shutdown, and queue behavior.
5. Stale runway/history behavior on worker failure.
6. Whether main-process RAM can still retain the large index or raw transcript data.
7. Compatibility with existing 7/30/90-day History, unknown-model pricing,
   project attribution, packaging, signed Core verification, and rollback.
8. Tests that are missing for a realistic failure mode.

Report findings by severity with exact file and line references. If there are no
Critical or Important issues, state that explicitly and list any remaining minor
risks. Do not request unrelated refactors.

## Re-review addendum — 2026-08-27

The first release review found three Important issues. The current diff now:

- Extracts and persists structural Codex/Claude session identities for renamed
  copy/delete deduplication, with filename identity as a fast fallback.
- Keeps a timed-out utility worker's promise and serialized writer queue pending
  until Electron emits the required process `exit` event.
- Documents append validation's exact inode/size/classification/tail boundary and
  adds an explicit Diagnostics full rebuild that repairs earlier in-place rewrites
  while preserving retained 90-day history for missing transcripts.
- Corrects the release minimum shell version to `0.2.5` because the repair IPC adds
  a fixed-preload API that ships in the `v0.2.5` DMG.
- Persists metadata-only duplicate paths outside aggregate-bearing entries so late
  structural deduplication stays zero-read on later refreshes and can promote a
  surviving copy if the primary disappears.
- Defers same-session loser suppression until the selected representative parses
  successfully, and falls back to another live copy in the same refresh if the
  selected file disappears.
- Treats the first nonzero Claude streaming row after an all-zero row as the
  billable call; only later nonzero revisions are token-only corrections.
- Keeps changed aggregate-bearing losers out of duplicate suppression until they
  parse in the same refresh; force repair revalidates every aggregate loser even
  when size and mtime were restored.
- Binds discovered identities to a dev/inode/mtime/size fingerprint before caching
  duplicate metadata, and rolls failed aggregate-group revalidation back to a
  retryable incumbent state.
- Learns full-rebuild identities only from current transcript content, with the
  current filename as fallback; cached identity is retained only for append state.

Re-review the entire release diff, not only these fixes. Re-run the original three
reproductions, inspect the repair IPC/UI and release-version compatibility, and look
for regressions or new Critical/Important issues. The full suite at the time passed
197/197 tests. A final private real-data canary completed successfully; exact
transcript counts, data volume, usage, and timing are omitted from this
public-project archive. Its immediate refresh rebuilt zero files, performed zero
identity-prefix reads, and contained zero duplicate aggregate keys.
