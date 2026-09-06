# Claude web usage polling

## Goal

Read Claude allowance from the normal authenticated usage page every 60 seconds in Usage Meter. Preserve Codex, account isolation, visible cached/error states, and unrelated local UI changes. Open a PR after tests and independent reviews; do not merge.

## Approach and verification

1. Verify a dedicated, sandboxed Electron browser session can load Claude and support normal user login. Never copy browser cookies or rotate Claude Code credentials.
2. For each poll, load the normal page in a fresh hidden window using the row's persistent session. Pair that document's bootstrap identity and usage responses, then destroy the window. Validate the account and organization and normalize exact reset timestamps. Keep credentials in the browser session.
3. Integrate with the existing 60-second refresh, sign-in, logout, and account lifecycle. Failed reads retain the original timestamp and become visibly cached. Respect server backoff; do not bypass sign-in or challenges.
4. Test normalization, account separation, authentication failures, rate limits, single-flight refresh, logout races, and packaging. Use an actual Electron fixture for browser lifecycle where feasible.
5. Run independent code reviews, resolve substantive findings, build the Core, and verify the installed artifact and live 60-second refresh. Preserve the installed local UI improvements.
6. Commit only this change, push the isolated branch, and open a PR with exact verification and any remaining blocker.

## Constraints

- Browser login may need the user to sign in. Finish the concrete connector first, then request only the required interaction.
- No automatic Claude CLI usage, refresh-token handling, cookie extraction, or direct replay of private web endpoints.
- Web markup and response schemas can change. Reject ambiguous identity or invalid payloads rather than reporting fabricated fresh data.
- A successful 60-second schedule does not guarantee the upstream service always returns a fresh reading.
