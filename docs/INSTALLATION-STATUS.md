# Mac installation status — October 4, 2026

All three Macs have the public **v0.2.17** arm64 release installed at `/Applications/Usage Meter.app`, with matching renderer/native sizing source hashes and valid strict code signatures. Each installed renderer was inspected, then each app was relaunched normally without debugging arguments and its running process rechecked.

The meter has stacked, readable account rows, no account-list scrolling, and a native window that grows to fit account details, usage, reset countdowns, exact local reset dates, and controls. Manual sizing cannot shrink below the current content height. Reset times that the provider does not report are labeled explicitly.

| Device | Installed app and layout | Provider data verified |
| --- | --- | --- |
| Work Mac (local) | 0.2.17; 320×317; native screenshot confirms all details and controls visible. | Live Claude and Codex readings. Claude weekly and Codex weekly countdowns match provider timestamps; Claude currently reports no 5-hour reset timestamp. |
| Home Mac (`samarths-macbook-pro-2`) | 0.2.17; native bounds 340×362 match measured intrinsic content height, including cached-data/sign-in messages. | Cached readings only: Claude needs Chrome Sign In, and saved Codex authentication is rejected. Expired known resets show `reset due`; fresh usage/reset times require Sign In for both providers. |
| Mac mini (`samarths-mac-mini`) | 0.2.17; 340×292; initialized renderer confirms every displayed detail fits without scrolling. | Codex weekly reading is live. Claude needs Chrome Sign In before it can report usage or a reset time. |

On the Home Mac, Chromium reports an old 340×292 viewport while the popover is hidden. Read-only CoreGraphics inspection independently confirms that the native window is already 340×362 before it opens. Its intrinsic row/header/footer/padding total is also 362. The fit is dispatched without waiting for animation frames, which pause in hidden renderers. Remote visible screenshots were not captured.

The source and public release are on GitHub main, release commit `f5a66ab`. The release ZIP SHA-256 is `b62b125f8057e4f5425aef2e6c061df7d89a480e9cb3fb744366dc82657ef84b`; this exact archive hash was verified on all three Macs. No logins or browser credentials were transferred.

Validation: 320 Node tests, independent source/layout review, six browser fixture states at 320px and 420px widths, native sizing regressions, local packaging preflight, and the successful GitHub release workflow. Installed source hashes match the final source on every host. Normal app and renderer/helper processes were rechecked after debugging.

Evidence, test logs, screenshots, official archive, and previous app backups are under `/Users/samarthkumbla/Documents/UsageMeterBackups/2026-10-04-no-scroll/`. Each remote host retains its previous installed app in that same directory on the host. Earlier source backups remain in the October 3 backup directory and named Git stash.

For the pending logins, open Usage Meter on the corresponding Mac and choose **Sign in** on the affected row. Complete that Mac's browser login; automatic one-minute provider refreshes resume afterward. This table records this verification session; provider authentication can change later.
