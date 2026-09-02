# Usage Meter Chrome sign-in review

> **Historical review prompt — completed and superseded.** Preserved for provenance; it does not describe the current working tree.

Review the point-in-time uncommitted diff in the Usage Meter repository as a strict, read-only code review.

## User requirement

Clicking a Usage Meter **Sign in** action must open the authentication page in Google Chrome, not Safari. The existing minimalist Sign in and Delete actions must remain intact.

## Intended behavior

- Claude sign-in launches `claude auth login` directly with its stdin pipe held open for the interactive OAuth exchange, while setting `BROWSER` to the installed Google Chrome executable. It must not route through Terminal.app or macOS Automation permission prompts.
- Codex sign-in explicitly opens `https://auth.openai.com/codex/device` in Google Chrome and launches `codex login --device-auth` in the account-specific `CODEX_HOME`.
- Electron no longer opens an embedded Claude login BrowserWindow.
- The tray action and account action use the same server-side sign-in path.
- Missing Google Chrome fails clearly instead of falling back to another browser.

## Review priorities

Look for correctness, regressions, shell quoting or command-injection risks, broken account isolation, authentication-flow mistakes, UI inconsistencies, unnecessary complexity, and missing tests. Validate findings against the actual code and current diff. Report only actionable findings with severity and file/line evidence; if clean, state that no actionable findings remain and identify residual verification limits.
