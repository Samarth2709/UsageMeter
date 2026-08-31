# Project history

This is a concise record of shipped milestones. It is not a substitute for Git history; use `git log` for the exact code-level change record.

## 0.2.6 — 2026-08-30

- Removed limit-exhaustion runway predictions, forecast notifications, and local prediction evaluation logging from the runtime and popover.

## 0.2.5 — 2026-08-27

- Added a fixed Electron bootstrap shell and signed, versioned Core updates with a safe staging path, atomic activation, rollback, and user-controlled restart.
- Added desktop-release automation that publishes the initial/shell DMG and ZIP alongside signed Core update assets. The shell still requires manual DMG replacement without an Apple Developer ID.
- Added current model pricing and richer Usage History insights: Usage Runway, Project Ledger, and Model Lens.
- Generalized Codex allowance handling so weekly-only or otherwise dynamic windows use server-reported metadata instead of a fabricated five-hour window.
- Replaced whole-transcript background reparsing with a compact incremental index in short-lived utility workers.
- Corrected Claude streaming totals, repeated Codex cumulative snapshots, renamed-session deduplication, and retained 90-day history.
- Added a Diagnostics index repair for non-append transcript rewrites and strengthened worker timeout serialization.
- Fixed popover visibility across macOS Spaces.

## Packaging and desktop integration — 2026-07-17

- Added the native Usage Meter icon, packaged-app launch-at-login behavior, and clean replacement of legacy installed bundles.
- Updated the installed app and release artifacts to v0.2.5; see [Releasing](RELEASING.md).

## 0.2.3 — 2026-07-01

- Reduced History RAM/CPU use with incremental per-file caches and window-open-only recomputation.
- Destroyed temporary windows after use and fixed dashboard hover-listener cleanup.

## 0.2.2 — 2026-06-28

- Added configurable extra transcript roots and the Diagnostics folder editor.
- Added state-aware diagnostics help and the Vercel site deployment workflow.

## 0.2.1 — 2026-06-28

- Added transcript source diagnostics, source counts, environment override visibility, and an empty-history explanation.

## 0.2.0 — 2026-06-26

- Added GitHub Release update checks and stabilized the DMG download artifact name.

## Usage History foundation — 2026-06

- Added local Claude/Codex transcript parsing, incremental aggregation, API-equivalent pricing, a dedicated dashboard, detailed charts, cache economics, and subscription-value projections.

## Historical planning material

The original design and execution plans are retained in [archive](archive/README.md) for provenance. They describe point-in-time requirements and may contain stale pricing, version, path, or implementation details. Current behavior is documented in the README and the active documents in this directory.
