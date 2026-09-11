# Claude Chrome reader verification

Verified in the installed macOS arm64 app on September 10, 2026.

- **311 tests passed**, including ten new recovery cases. Independent review found an unconfirmed-opening loop; the correction stops automatic openings after one failed attempt. Follow-up review has no remaining actionable findings.
- The actual Chromium fixture passed with local HTTPS responses, account checks before and after usage, changing allowances, cleared resource timings, and 429 backoff. It makes no external requests.
- Installed **0.2.14** automatically replaced the previously closed tab in the requested work profile and fetched fresh usage. Closing that replacement also recovered on the next automatic poll, without Sign In or manual refresh. Restarting Usage Meter reused the same tab and accepted a fresh reading. Replacing the tab with a new native ID also recovered without opening a duplicate. Four successive readings arrived 60.839, 59.169, 59.832 seconds apart.
- The signed canonical ZIP matches the feature source; the DMG checksum is valid. The installed app preserves all 11 pre-existing public UI files and the prior local server auth fixes, which remain excluded from the PR and canonical release archive. Installed source hashes and strict deep signature verification pass; the compact UI displays fresh Claude data.

The complete Chrome process was not restarted during live checks; a new-tab-ID scenario exercised its recovery path without disrupting other browser work. Allowance changes were tested with fixtures; live usage remained 0% during this check.

Chrome must be running. Profile recovery requires a unique saved Chrome email matching the Claude account; otherwise manual Sign In remains available. Account, email and organization checks still gate usage acceptance. Permission settings and browser credentials are unchanged.

Local evidence is under `build/tab-recovery-20260910/`: source hashes, before-state, lifecycle checks, polling samples and the previous installed app for rollback. No credentials or raw browser responses are recorded there. The earlier 0.2.13 verification remains under `build/chrome-install/`.
