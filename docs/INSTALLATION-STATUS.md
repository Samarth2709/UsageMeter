# Mac installation status — October 3, 2026

All three Macs have the public **v0.2.15** arm64 release installed at `/Applications/Usage Meter.app`, with matching countdown source hashes and valid strict code signatures. The initialized installed renderer was checked independently on each device, then each app was relaunched without debugging arguments.

| Device | Installed app | Provider data verified |
| --- | --- | --- |
| Work Mac (local) | 0.2.15 | Live Claude 5-hour/weekly and Codex weekly readings; visible countdowns and exact local reset tooltips match provider timestamps. |
| Home Mac (`samarths-macbook-pro-2`) | 0.2.15 | Cached readings only: Claude needs Chrome Sign In, and saved Codex authentication is rejected. Expired known resets display `reset due`; new live reset times require Sign In for both providers. |
| Mac mini (`samarths-mac-mini`) | 0.2.15, first installation | Codex weekly reading is live. Claude needs Chrome Sign In before it can report usage or a reset time. |

The source and public release are on GitHub main, release commit `cb11e92`. The release ZIP SHA-256 is `3650fa0c1d2edce1f370204a597f818661777f9742e13c17fcafdc16e5ca3cb6`; the same archive hash was verified on both remote Macs. No logins or browser credentials were transferred.

Validation: 319 Node tests, independent review (86 targeted tests), local DMG checksum/build, GitHub release workflow, and browser layout checks at 236×160/190/212 and larger sizes. Every reported window now has visible reset text; cached values tick once a second, pending actions retain their status, and elapsed known timestamps are labeled due.

Local runtime evidence, test logs, screenshots and previous app/source backups are under `/Users/samarthkumbla/Documents/UsageMeterBackups/2026-10-03-reset-fix/`. Each previously installed remote app has its own backup at that same path on its host. Earlier local tracked edits are also preserved in a named Git stash; their installed UI/auth fixes are incorporated into this release. The previous long local plan is preserved as `prior-plan.md` in the backup directory.

For the pending logins, open Usage Meter on the corresponding Mac and choose **Sign in** on the affected row. Complete that Mac’s browser login; the app resumes automatic one-minute provider refreshes afterward. Authentication status is time-sensitive: this table records this verification session, not a permanent guarantee.
