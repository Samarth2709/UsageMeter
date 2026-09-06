# Claude usage through Chrome

## Goal

Sign In opens the Claude usage page in the user's Google Chrome profile and reuses its existing login. Read fresh allowance every 60 seconds through that Chrome tab. Preserve Codex, unrelated local UI changes, and honest cached timestamps. Update draft PR #7 after independent review; do not merge.

## Implementation and verification

1. Replace the embedded Electron browser with Chrome's native Apple Events interface. Sign In creates or focuses one dedicated tab; polling never launches Chrome or changes the active tab. Persist only the per-row tab ID.
2. Inside that ordinary authenticated Claude page, make same-origin reads of the bootstrap and usage endpoints for the saved organization. New rows may discover the organization from the page's bootstrap request. Validate saved account and organization before usage and recheck identity afterward. Cookies and authorization headers stay in Chrome. Bound reads and respect 429 Retry-After.
3. Disconnect and row deletion forget the local tab association without signing the user out of shared Chrome. Closed tabs, stopped Chrome, wrong profiles, missing permissions and expired logins show actionable Sign In errors with explicitly cached old readings.
4. Test the real page collector against local fixtures, native bridge generation, single-flight, lifecycle races, persistence and server integration. Run independent review, build and verify installed artifact parity, Chrome Sign In and multiple 60-second readings.
5. Preserve installed local UI changes, update docs and existing draft PR with exact verification.

## Approved permission change

The packaged app needs the macOS Apple Events automation entitlement and a usage description explaining Chrome access. The user approved this permission change on September 5, 2026. Do not change Chrome preferences or macOS permissions programmatically. Keep Chrome open and its dedicated usage tab available.

## Completion

Implemented, independently reviewed, packaged and installed as 0.2.13. Verified native Chrome Sign In, successive 60-second reads, restart persistence, closed-tab recovery, strict signatures, and preserved local UI. 301 tests and the offline Chromium fixture pass. PR #7 is updated without merging.
