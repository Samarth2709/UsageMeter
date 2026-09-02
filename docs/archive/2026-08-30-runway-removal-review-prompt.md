# Final reviewer brief: remove runway prediction

> **Historical review prompt — completed and superseded.** Preserved for provenance; it does not describe the current working tree.

Review the current uncommitted UsageMeter diff against `HEAD` in read-only mode. Do not edit files.

Primary new requirement:

- Remove the limit-exhaustion/runway prediction feature end to end: calculation, worker operation, evaluation logging, notifications, IPC/preload exposure, popover rendering, CSS/HTML, tests, and active documentation.
- Preserve live provider-reported usage percentages and reset times.
- Preserve Usage History and its subscription/window value projection; that is historical accounting, not a limit-exhaustion prediction.

Also review the complete product diff already produced by the earlier 20-agent review for release-blocking correctness, regressions, security/privacy, lifecycle, packaging, and UX issues.

Verification already completed by the primary agent:

- `npm test`: 205/205 pass.
- `TZ=UTC npm test`: 205/205 pass.
- `npm run build:core`: pass; dependency audit reports 0 vulnerabilities.
- Compact popover rendered at its production dimensions with no runway DOM nodes, no overflow, and no browser console warnings/errors.
- `git diff --check`: pass.

Report only actionable findings, ordered by severity, with exact file and line references. If there are none, say so explicitly. Do not modify the workspace.

## Follow-up: Claude stale-status fix

After the first review, the user surfaced a live UX bug. Claude Code 2.1.251 emits valid `{"loggedIn":false}` JSON but exits with status 1; Usage Meter treated that as an opaque child-process failure and rendered the entire command path in the popover.

Review the current three-file uncommitted follow-up diff in `server.js`, `public/app.js`, and `test/server.test.js`. Confirm that structured logged-out output is handled safely, invalid failures still propagate, and stale UI text is concise without hiding detailed diagnostics entirely. Do not edit files.
