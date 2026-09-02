# Usage Meter repeated Chrome sign-in review

> **Historical review prompt — completed and superseded.** Preserved for provenance; it does not describe the current working tree.

Review the point-in-time uncommitted diff relative to `27acb5c` in the Usage Meter repository. Stay read-only.

## Reproduced bug

The installed app retained a four-hour-old `claude auth login` child after its Chrome tab was closed. A later Sign in click briefly showed Opening, then reused the already-resolved startup promise and opened no Chrome tab.

## Intended fix

- Concurrent calls during the 1.5-second startup window reuse one child and one startup promise.
- A later explicit Sign in call closes stdin and terminates the already-started child, then creates a fresh Claude OAuth process so Chrome opens a new usable page.
- Exit/error cleanup from the replaced child must never clear the replacement child.
- At most one active Claude OAuth listener remains after replacement.

## Review focus

Check event-order races, promise behavior, child-process cleanup, double-click/tray concurrency, false success, resource leaks, Chrome behavior, and regression-test quality. Report only actionable findings with severity and file/line evidence. If clean, say so and state residual limits.
