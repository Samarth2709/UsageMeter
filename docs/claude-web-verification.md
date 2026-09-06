# Claude Chrome reader verification

Verified in the installed macOS arm64 app on September 5, 2026.

- **301 tests passed.** Coverage includes identity and organization binding, exact reset times, cached errors, 429 backoff, disconnect races, tab persistence, wrong-profile/auth/permission recovery, and refresh coalescing. Independent reviews have no remaining actionable findings.
- The actual Chromium fixture passed with local HTTPS responses: identity checks before and after usage, changing allowances, cleared resource timings, and backoff. It makes no external requests.
- Installed **Sign In** opened Google Chrome and reused the existing work-profile login. Four successive live readings arrived 59.905, 60.008, and 60.074 seconds apart. After the final auth-recovery correction, restart reused the same Chrome session. Closing the connected tab produced explicit Cached data and Sign In; reconnect restored a fresh reading, followed by two automatic readings 59.879 seconds apart.
- Native UI inspection showed live Claude data and preserved the compact layout. The installed app retains all 11 pre-existing public UI files and the prior local server auth fixes; these local additions are excluded from the PR and canonical release archive.
- The canonical 0.2.13 ZIP matches the PR source, the DMG checksum is valid, and both the release bundle and installed app pass strict deep signature verification. The Apple Events entitlement and Chrome usage description are present. Shell 0.2.12 rejects the new Core; 0.2.13 accepts it.

Live allowance values stayed constant during this installed-app check; changed values were exercised in the Chromium fixture. Chrome and its connected usage tab must remain open. Provider throttling, expired login, or a future web API change can still require a retry or reconnection.

Local evidence is under `build/chrome-install/`: source hashes, polling samples, restart/lifecycle checks, and the previous installed app for rollback. No credentials or raw browser responses are recorded there.
