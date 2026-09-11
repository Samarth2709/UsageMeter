# Claude tab recovery — September 10, 2026

## Confirmed failure

Installed 0.2.13 still points at a closed Chrome tab. Its last Claude reading is from September 8. The Cantina Chrome profile has a valid Claude Team session for the saved organization. The work email matches a single Chrome profile; the personal profile must not be selected.

## Scope and verification

1. Preserve the original dirty checkout and installed renderer/server additions. Work only in the existing Claude feature worktree.
2. Reproduce a missing native tab and add regression coverage. Recover an existing connection in the Chrome profile whose saved Google email uniquely matches the Claude row. Reuse a marked usage tab after browser restart; open at most one replacement when needed. A closed browser waits for the user to reopen Chrome. Explicit disconnect stays disconnected. Sign In chooses the matching profile when available.
3. Keep provider account/email/organization verification, backoff, bounded requests, cancellation and original cached timestamps. No browser credential extraction or permission changes.
4. Run unit and offline Chromium tests, independent review, build and install with rollback. Verify the actual Cantina account, tab-close recovery, app restart and successive minute polls. Do not restart the user's entire Chrome session just for testing.

## Review prompt

Review the uncommitted Claude tab-recovery changes against 8b84790 in /Users/samarthkumbla/Documents/Projects/UsageMeter-claude-web. Read this plan and claude-web-usage.js plus tests and calling code. Stay read-only; do not operate the browser, make provider calls, mutate files or Git, or expose credentials. Focus on wrong-profile acceptance, reopening loops, browser restart/tab closure, explicit disconnect/cancellation, stale data and Retry-After. Report only actionable findings with file and line references. Local fixture tests are allowed.

## Review correction

An opening that cannot be rediscovered now clears the old association after one attempt. Background polls cannot accumulate replacement tabs; explicit Sign In can retry immediately. Regression coverage exercises eight subsequent minute polls.

## Completion

Installed 0.2.14 with the prior renderer/server additions preserved. Verified automatic recovery from the original stale tab, another tab closure, a replacement tab ID, app restart and four successive minute readings. 311 tests, offline Chromium checks, follow-up independent review, source parity, strict signatures and DMG verification pass. The full Chrome process was left running to preserve unrelated user work.
