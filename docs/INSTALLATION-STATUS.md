# Mac installation status — October 4, 2026

All three Macs have public **v0.2.18** installed at `/Applications/Usage Meter.app`, with valid strict signatures, matching source hashes, and normal app/renderer processes after verification.

The original small proportions are restored: default width **276 px**, minimum **236 px**, side-by-side accounts at widths up to 320 px, 56 px rings, small labels, and one visible countdown line per allowance. Exact reset dates/times and full account names remain available on hover. The account list never scrolls; native height fits the content. The larger saved dimensions from the previous rollout were backed up and reset to automatic fitting on each Mac.

| Device | Verified compact layout | Provider state |
| --- | --- | --- |
| Work Mac | 276×202; native screenshot and initialized renderer confirm visible usage/countdowns/controls without scrolling. | Live Claude and Codex. Claude currently reports no 5-hour reset timestamp; the UI explicitly says so. |
| Home Mac (`samarths-macbook-pro-2`) | Native bounds 276×233 exactly fit measured intrinsic content, including cached labels and Sign in controls. | Cached readings; both Claude and Codex need Sign in for fresh values. |
| Mac mini (`samarths-mac-mini`) | Native bounds 276×173 exactly fit measured intrinsic content. | Codex is live; Claude needs Sign in. |

Hidden Chromium renderers can report their old viewport size until shown. Read-only CoreGraphics inspection independently confirms the current native dimensions on both remote Macs; these match intrinsic rows/padding/footer measurements. Remote visible screenshots were not captured. No credentials were transferred.

Release commit: `8a21a1c`. Official ZIP SHA-256, verified on all three Macs: `70133ea89fe3d3d2f91cd7638b0ca197f5ba6d91260186f602c295c0afaa8707`.

Validation: 320 Node tests; independent review with 19 targeted tests and 20 browser layout cases covering three accounts, multiple states, and widths 236/276/320/321; local browser fixtures; successful GitHub build/signature/archive validation. Layout fitting converges without resize loops across the width breakpoint. Installed app, stylesheet and native sizing source hashes match the final source on every host.

Evidence, tests, previews, official archive, previous apps, and previous window settings are under `/Users/samarthkumbla/Documents/UsageMeterBackups/2026-10-04-compact/`. Remote hosts retain their own previous app and window settings in that directory.

For fresh remote readings, choose **Sign in** on each affected row on that Mac. This table records this verification session; authentication can change later.
