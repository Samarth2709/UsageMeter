# Token Counting Review Request

> **Historical review brief — completed and superseded.** Preserved for provenance; use [Architecture](../ARCHITECTURE.md) for current behavior.

Review the current uncommitted UsageMeter changes for token-counting correctness.
This is a read-only review: do not edit files.

Base commit: `f7d5e61afdd326bfa818f9bf2bc8d588bb9ee32a`

## Implemented behavior

- Claude repeated rows for one streamed message contribute the final token total
  while counting one model call.
- Codex token events with an unchanged cumulative usage snapshot are not counted
  again.
- Indexed daily history survives source-transcript cleanup for the supported
  90-day dashboard, then ages out.
- The version-2 index migrates to version 3, rebuilds live transcripts with the
  corrected parsers, and restores exact legacy contributions for deleted files
  when they are not already represented by a session identity.

## Evidence

- `npm test`: 163/163 passed.
- An isolated private large-scale rebuild completed successfully.
- Real-data comparison confirmed material corrections to both Codex and Claude
  totals; exact private usage volumes are omitted from this public-project archive.
- The correction restored previously missing model history.

## Review scope

- `usage-history/parseClaude.js`
- `usage-history/parseCodex.js`
- `usage-history/contributions.js`
- `usage-history/index.js`
- corresponding tests and the narrow README/architecture updates

Prioritize duplicate/missing usage, incremental append state, index migration,
rename/replacement behavior, retention boundaries, incorrect call counts, and
any realistic data-loss or double-counting path. Report findings by severity
with exact file and line references. State clearly whether there are any
Critical or Important issues and whether the change is ready to package.
