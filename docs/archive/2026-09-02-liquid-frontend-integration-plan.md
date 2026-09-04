# Integrate the liquid frontend

## Objective

Move the complete uncommitted liquid-meter frontend and Claude usage backoff from the dirty main checkout into a clean branch based on release 0.2.10, while preserving the merged OAuth-race protections and the original checkout exactly as-is.

## Requirements

- Include every intentional tracked, staged, and untracked local change that belongs to the new frontend.
- Preserve the rule that Usage Meter never launches Claude automatically and never refreshes or rewrites Claude OAuth credentials.
- Keep genuinely stale/cached values grey and visibly labelled `Cached`, including low-limit rows.
- Preserve exact account identity, logout, deletion, and tombstone protections.
- Keep frameless-window dragging, row context actions, bottom-bar controls, reduced-motion behavior, and dynamic row sizing usable.
- Back off after Claude usage rate limits without falsely marking a recent successful reading stale.
- Verify the browser surface, packaged native app, signed artifact, installed source parity, and live `samarthk@cantina.security` usage path.
- Review the full branch and fix every Critical or Important finding before publication.

## Plan

1. Transplant the dirty checkout's full local delta into this worktree without changing the source checkout.
2. Review the liquid renderer, stale styling, drag IPC, sizing, lifecycle cleanup, and Claude backoff behavior.
3. Add focused tests for any repaired invariants and update active documentation.
4. Run focused and full tests locally and under `TZ=UTC`, syntax and diff checks, then exercise the real browser and Electron surfaces.
5. Build the arm64 package, verify DMG/signature/source parity, install the reviewed artifact, and smoke-test the running app.
6. Request an independent review, fix blocking findings, rerun affected checks, push, and open a follow-up PR from the latest `main`.

## Acceptance criteria

- The clean worktree contains the complete intended local frontend/backoff delta and the dirty checkout is byte-for-byte untouched.
- Cached rows are neutral grey and motionless regardless of remaining percentage.
- Fresh Claude reads use only the Keychain access token; a 429 starts bounded backoff and recent data remains live until the documented stale threshold.
- All tests, package checks, native UI checks, and independent review pass.
