# UsageMeter logged-out state review

> **Historical review prompt — completed and superseded.** Preserved for provenance; it does not describe the current working tree.

Review the uncommitted diff relative to `74a9310`.

## Requirement

When an account cannot refresh because it is logged out, UsageMeter must not render cached percentages, reset timers, or any `Last known` message. It should render compact `Sign in` and `Delete` actions. A failed Claude `auth status --json` probe must use that same signed-out state instead of a Retry-only state. Other stale refresh failures should hide cached usage and expose Retry. Fresh usage remains unchanged.

## Review focus

- No cached usage leaks during startup, logged-out snapshots, or other stale snapshots.
- Fresh provider limits still render correctly.
- Login and retry state transitions do not retain stale DOM, state, tooltips, or copy.
- Claude and Codex action behavior remains functional.
- Header status, countdown redraws, and snapshot application remain coherent.
- UI remains compact and accessible.
- Tests actually cover the renderer and click paths.
- Scope is surgical and does not alter stored usage/history.

Report only high-confidence actionable findings, ordered by severity, with exact file and line references. If there are none, say so and list verification performed. Do not modify files.
