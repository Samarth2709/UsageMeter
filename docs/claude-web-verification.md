# Claude web reader verification

Status: implemented and reviewed; live authentication and sustained polling in the new Electron reader remain unverified.

## Completed

- Baseline: 276 Node tests passed. Final suite: 296 tests passed, including a clean dependency install.
- Focused regressions cover strict percentages/reset parsing, account and organization mismatches, weekly-only windows, concurrent reads, navigation changes, login completion, logout races, and API/page-level rate limits.
- The offline Electron fixture passed with actual sandboxed windows and local HTTPS responses: both response bodies were collected, changing usage was reflected, windows were cleaned up, and 429 backoff prevented another request. It made no external requests.
- Core build and packaged-source parity passed. The arm64 DMG passed `hdiutil verify`.
- Independent design and implementation reviews completed. Three implementation findings were fixed and retested: preserving a usable error after rate-limit cancellation, honoring document-level 429 responses, and blocking reads during session clearing. The follow-up review reported no remaining actionable findings.
- The local installed app passed startup, deep strict signature verification, and staged-file hash checks. Its existing local UI and Keychain error handling were preserved; those unrelated changes are excluded from this PR.

## Still required

The Mac locked before interactive verification. Unlock it, open Usage Meter, and select **Sign in** on the Claude row using the saved account and organization. Then verify fresh `claude_web_usage` readings on successive 60-second background refreshes, changing allowance, restart persistence, and the installed compact UI.

The ordinary Claude web page's current bootstrap identity fields and usage/reset fields were inspected through Chrome's response preview. That schema inspection and the offline fixture do not establish that embedded sign-in, upstream throttling, or future page versions will work. Keep the PR in draft until the new reader passes live verification.
