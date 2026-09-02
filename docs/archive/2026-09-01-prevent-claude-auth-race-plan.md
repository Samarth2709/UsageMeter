# Prevent Claude OAuth refresh races

## Objective

Prevent Usage Meter from participating in Claude Code OAuth refresh races while preserving useful Claude allowance data when the authenticated web source is temporarily unavailable.

## Requirements

- Usage Meter must not launch Claude Code in the background, on startup, on a timer, after sign-in, or during manual refresh.
- The only permitted Claude Code process launches are explicit user actions: **Sign In** and **Log Out**.
- Claude allowance refresh must use the existing authenticated `claude.ai` web session.
- When a web refresh fails and cached allowance data exists, keep showing those values as stale.
- Stale values must be grey and include a visible `Cached` label; color cannot be the only stale-state signal.
- A stale authentication error must show cached values without claiming that the account is live or replacing them with a misleading sign-in-only state.
- Remove Claude from the opt-in five-hour reset automation because it launches Claude Code without an immediate user action; preserve the unrelated Codex automation.
- Preserve Codex refresh behavior and local Claude/Codex transcript indexing.
- Update active documentation so it describes the web-only Claude allowance path and removed automation.

## Implementation plan

1. Characterize the existing CLI fallback, web-cache merge, stale-result preservation, and renderer behavior with focused tests.
2. Remove the Claude CLI `/usage` capture and every automatic caller, including Claude participation in the optional reset automation.
3. Make the Electron refresh pipeline produce a cached stale Claude result whenever web refresh cannot supply fresh values.
4. Render stale data in the existing account row with a grey treatment, a `Cached` label, the failure reason in accessible title text, and no success status.
5. Update README, architecture, development, and history documentation.
6. Run focused tests, the complete test suite locally and under `TZ=UTC`, syntax checks, Core build, packaging, and UI/process verification.
7. Review the committed diff against this plan. Fix every Critical and Important finding, rerun verification, then push and open a PR.

## Acceptance criteria

- Static and runtime tests prove startup, background refresh, manual refresh, and post-login refresh cannot call the Claude CLI usage path.
- Source contains no `/usage` pseudo-terminal capture or five-hour Claude auto-start path.
- Fresh values retain their normal service color; stale values and reset text are visibly grey and labeled `Cached`.
- Stale accounts do not contribute to the healthy green overall status.
- The packaged Core matches the reviewed source and launches without spawning a background Claude process.
- The existing dirty main checkout remains untouched.
