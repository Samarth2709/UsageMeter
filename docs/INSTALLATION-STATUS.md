# Mac installation status — October 4, 2026

The user requested a full return to the version before scrolling removal. All implementation, design, and test files are restored exactly from `13b9828` (the v0.2.15 implementation). Only release-version metadata and this installation record differ. The restored implementation is published as **v0.2.19** so the latest release also contains the rollback. The original scrolling, compact layouts, proportions, sizing behavior, reset presentation, and tooltips are restored; no redesign is retained.

| Device | Installed app and restored dimensions | Provider state |
| --- | --- | --- |
| Work Mac | 0.2.19; 236×190 | Live Claude and Codex readings. Claude currently does not report a 5-hour reset timestamp. |
| Home Mac (`samarths-macbook-pro-2`) | 0.2.19; 276×175 | Cached readings; both providers need Sign in for fresh values. |
| Mac mini (`samarths-mac-mini`) | 0.2.19; 276×175 | Codex is live; Claude needs Sign in. |

Dimensions match the installed-renderer evidence captured before the scrolling changes in `/Users/samarthkumbla/Documents/UsageMeterBackups/2026-10-03-reset-fix/`. Each current installed renderer was independently inspected, and the local native UI was visually checked. Every host was then relaunched normally without debugging arguments and its app/renderer processes checked. Installed app, stylesheet, and native sizing hashes match the original v0.2.15 source. Strict code signatures pass on all three Macs.

Release commit: `26eea72`. Official ZIP SHA-256, verified on all three Macs: `754a0e1b5453f571bad35d03f9eb474acef88b90888a045650ab96bfe066b1df`. Validation: all 319 original Node tests; independent exact-source rollback review and 18 targeted tests; successful GitHub release build/signature/archive validation.

Evidence, tests, official archive, previous apps, and previous window settings are under `/Users/samarthkumbla/Documents/UsageMeterBackups/2026-10-04-full-rollback/`. Remote hosts retain their own previous app/window settings in that directory. Provider credentials were preserved and were not transferred. For fresh remote readings, choose **Sign in** on each affected row on that Mac.
