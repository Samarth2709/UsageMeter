# Incremental Usage Index Plan

> **Historical document — completed and superseded.** This August 2026 implementation plan is preserved for provenance. Use [Architecture](../ARCHITECTURE.md) and [Development](../DEVELOPMENT.md) for current behavior and verification.

## Goal

Keep Usage Meter's background CPU and memory bounded as local Codex and Claude
transcript history grows while preserving the corrected parser totals, pricing
coverage, and 7/30/90-day History views, with a documented sub-minute runway
boundary tolerance.

## Design

1. Persist one versioned usage index under `~/.rate-limit-tool/`.
   - Daily CLI/model/project aggregates support History.
   - Recent minute buckets support allowance value and runway calculations.
     A non-minute-aligned start conservatively includes its first partial minute,
     keeping boundary precision within 60 seconds without retaining raw events.
   - Each file records identity, observed size, processed byte offset, parser
     continuation state, and the aggregates contributed by that file.
2. Discover files with a metadata-only inventory.
   - New files are indexed.
   - Unchanged files are never opened.
   - Append-only files are read from their last processed byte.
   - Truncated, replaced, reclassified, or indexed-tail-modified files are rebuilt individually.
   - Missing files are reconciled hourly.
3. Run index updates in a short-lived Electron utility process.
   - The menu-bar process receives only compact History/runway results.
   - Parsing allocations are reclaimed when the worker exits.
   - Index writes are atomic and worker requests are serialized.
4. Rebuild live transcripts once when migrating the existing `usage-history.json`
   and `window-points.json` caches because those public caches preserve the old
   Claude streaming and Codex cumulative-snapshot miscounts. Retain cached 90-day
   aggregates only for transcripts the CLIs already deleted; subsequent refreshes
   are append-only. A 10,494-file production-scale fixture completed in 43 seconds.
5. Reserve a full content rebuild for an index-version change, corruption, or an
   explicit Diagnostics repair path. Arbitrary in-place rewrites earlier in an
   already-indexed prefix cannot be detected without rereading that prefix, so the
   repair path makes that integrity/performance boundary explicit. The hourly
   pass is metadata reconciliation, not an unconditional reread of every
   transcript.

## Verification

- Appending to a large transcript reads only the appended bytes after its first
  indexed pass.
- Unchanged scans read zero transcript bytes.
- Truncation/replacement rebuilds only the affected file.
- The Diagnostics repair path corrects an earlier in-place rewrite while preserving
  retained 90-day aggregates for transcripts that have already been cleaned up.
- Partial trailing JSONL records are not lost or double-counted.
- Incremental and clean-rebuild totals match for Codex, Claude, project attribution,
  unknown models, window values, and runway inputs.
- Relevant focused tests, the full test suite, `git diff --check`, Core build,
  packaged app signing, installed-file parity, and live UI checks pass.
- Live idle/refresh CPU and memory are measured after installation and compared
  with a captured pre-change baseline. Exact private-machine telemetry is omitted
  from this archived public-project record.
