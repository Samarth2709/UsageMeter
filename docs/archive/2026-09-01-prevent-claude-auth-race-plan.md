# Prevent Claude OAuth refresh races

## Objective

Prevent Usage Meter from participating in Claude Code OAuth refresh races while preserving useful Claude allowance data when the read-only API source is temporarily unavailable.

## Requirements

- Usage Meter must not launch Claude Code in the background, on startup, on a timer, after sign-in, or during manual refresh.
- The only permitted Claude Code process launches are explicit user actions: **Sign In** and **Log Out**.
- Claude allowance refresh must use Claude Code's existing macOS Keychain access credential for read-only profile and usage requests.
- Usage Meter must discard Claude's refresh token after parsing the Keychain credential and never return, use, or write it; an expired or rejected access token requires an explicit Sign In action.
- When a web refresh fails and cached allowance data exists, keep showing those values as stale.
- Stale values must be grey and include a visible `Cached` label; color cannot be the only stale-state signal.
- A stale authentication error must show cached values without claiming that the account is live or replacing them with a misleading sign-in-only state.
- Remove Claude from the opt-in five-hour reset automation because it launches Claude Code without an immediate user action; preserve the unrelated Codex automation.
- Preserve Codex refresh behavior and local Claude/Codex transcript indexing.
- Update active documentation so it describes the read-only Keychain-backed Claude allowance path and removed automation.

## Implementation plan

1. Characterize the existing CLI fallback, stale-result preservation, and renderer behavior with focused tests.
2. Remove the Claude CLI `/usage` capture and every automatic caller, including Claude participation in the optional reset automation.
3. Read the saved Claude Code access credential from macOS Keychain and call the profile and usage endpoints without launching Claude or rotating OAuth credentials.
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
