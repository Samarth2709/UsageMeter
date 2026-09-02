# UsageMeter Claude sign-in review

> **Historical review prompt — completed and superseded.** Preserved for provenance; it does not describe the current working tree.

Review the uncommitted diff relative to `d3e4c60`.

## Requirement

When cached Claude usage is shown because the machine is logged out, expose a clear `Sign in` action. Clicking it must use the existing Electron Claude web-login flow, preserve cached usage while the login page opens, remain compact, and avoid changing unrelated provider behavior.

## Review focus

- UI state transitions for fresh, stale-login, stale-non-login, disconnected, retry, and repeated sign-in clicks.
- Whether the action reaches the existing `rate-limit:open-login` IPC path and `showClaudeUsageLogin()` window.
- Accessibility, tooltip copy, sizing, and provider-specific styling.
- Test quality and missing edge cases.
- Surgical scope; no unrelated changes.

Report only high-confidence actionable findings, ordered by severity, with exact file and line references. If there are none, say so and list the verification you ran. Do not modify files.
