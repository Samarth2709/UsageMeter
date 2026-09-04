# Liquid frontend integration review

Review the complete uncommitted working-tree diff in
`/Users/samarthkumbla/Documents/Projects/UsageMeter-worktrees/liquid-frontend-integration`
against base commit `c91d36e` and the requirements in
`docs/archive/2026-09-02-liquid-frontend-integration-plan.md`. This is a
read-only review: do not edit, stage, commit, install, push, or open a PR.

## What changed

- Replaced generated CSS wave keyframes with a shared canvas liquid renderer.
- Made account rows fill the popover, added pointer-driven clamped window drag,
  a proximity-revealed bottom bar, and dynamic content sizing.
- Preserved cached usage visibly while making all stale rows neutral grey and
  motionless, including stale readings that are also below the low threshold.
- Added bounded Claude 429 backoff and a six-minute freshness threshold so one
  failed poll does not immediately label a recent reading stale.
- Removed the obsolete wave generator and updated architecture, design, and
  development documentation.
- Added regression coverage for stale rendering, backoff, freshness aging, and
  non-finite drag deltas.

## Review focus

- Authentication isolation: Usage Meter must never start Claude during refresh,
  mutate Claude credentials, or reuse stale login-process state.
- Freshness truthfulness: stale/cached data is always visibly grey and
  motionless; recent fallback data must not be mislabelled.
- Backoff correctness: 429 handling avoids request loops, honors bounded
  `Retry-After`, and resets only on a successful read or completed sign-in.
- UI correctness: canvas lifecycle, reduced motion, CPU implications, geometry,
  context menus, dragging, and bottom-bar interactions.
- Electron security: renderer IPC inputs are validated and stay narrowly scoped.
- Documentation, test quality, and scope discipline.

Report strengths and findings grouped as Critical, Important, and Minor. For
every finding include a file and line reference, why it matters, and a concrete
fix. End with `Ready to merge: Yes`, `No`, or `With fixes`. Do not invent issues;
say explicitly when a severity group has none.
