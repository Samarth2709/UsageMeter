# Usage Meter Multi-Agent Review and Installation Plan

> **Historical document — completed and superseded.** This point-in-time review plan is preserved for provenance and is not a current operating procedure.

## Goal

Review the exact current `origin/main` revision of Usage Meter with 20 independent
reviewer agents, reproduce and fix verified material defects locally, and prove
that the latest reviewed release is installed and running on both the current Mac
and a secondary Mac.

## Assumptions and boundaries

- "whole Mac" was interpreted as "secondary Mac." This historical assumption was
  to be corrected before execution if needed.
- Review target: `origin/main` at
  `01e0f59f839691b490e884162121378d871637cd` unless a fresh fetch changes it.
- The incremental-index plan and review briefs were treated as historical process
  artifacts and excluded from product-code changes.
- Reviewer agents are read-only. They return evidence; they do not edit, commit,
  push, publish, install, or operate live action-capable features.
- No commit, push, tag, GitHub release, or pull request is authorized by this
  request. Any fixes remain local unless separately authorized.
- Installation on both Macs is authorized, but only after the exact artifact and
  targets are resolved and verified. The old app bundle will be preserved as a
  dated backup before replacement.

## Current checkpoint

- A fresh `git fetch --tags --prune` found local `HEAD`, `origin/main`, and the
  peeled `v0.2.5` tag at `01e0f59`.
- `/Applications/Usage Meter.app` on this Mac reports version/build `0.2.5`, passes
  `codesign --verify --deep --strict`, and is running from the expected bundle.
- GitHub CLI is currently unauthenticated, but the public GitHub API confirms the
  latest published release is v0.2.5 and records the DMG SHA-256 as
  `370b9c6f1324704885969ee6d2263ccec0cbaffde8f0ee24bb1aa946fc8a20c8`.
  The installed bundle still needs byte-for-byte comparison with that artifact.
- Repository-local `review.md`, `research.md`, and `ui.md` were not present.

## Execution plan and success criteria

1. Freeze evidence and target revision.
   - Refresh remote refs and public GitHub release/workflow metadata.
   - Record repository, tag, release, artifact, and installed versions separately.
   - Verify: immutable commit SHA and release asset digests are recorded.
2. Run 20 independent reviewer agents in batches of at most three.
   - Use the exact prompts in the
     [archived reviewer assignments](2026-08-30-full-application-reviewer-prompts.md).
   - Keep every agent read-only and scoped to one review dimension.
   - Verify: all 20 return a finding list or an explicit no-finding conclusion.
3. Consolidate and reproduce.
   - Deduplicate overlapping reports.
   - Reproduce every Critical/Important finding and realistic user-visible bug.
   - Reject speculative or source-only claims that do not survive inspection or a
     focused test.
   - Verify: each retained finding has file:line evidence and a failing test,
     runtime reproduction, or a clearly stated static-only limitation.
4. Fix only verified in-scope defects locally.
   - Prefer the smallest change that addresses correctness, bugs, UX, or code
     organization directly implicated by the defect.
   - Add focused regression coverage before or with each fix.
   - Do not perform unrelated cleanup.
   - Verify: focused reproductions pass and the diff maps directly to findings.
5. Re-review material fixes.
   - Reassign the relevant specialist plus one adversarial generalist.
   - Repeat until no Critical/Important issue remains or an exact blocker is
     documented.
6. Run the full local release gate.
   - Run the full test suite under local time and UTC, syntax/type/build checks
     available in the project, `git diff --check`, Core build, and macOS package.
   - Exercise the menu-bar popover, refresh, History ranges, Diagnostics, updater
     state, launch-at-login behavior, recovery paths, and macOS Space visibility.
   - Measure idle/refresh CPU and memory and check for retained workers/windows.
   - Verify: all tests pass, the packaged app is signed consistently with the
     project, and safe UI paths work in the packaged artifact.
7. Reconcile installation targets.
   - Identify and ping the exact secondary-Mac Tailscale peer before any SSH or install.
   - Inspect version, signature, process path, architecture, and current bundle on
     both Macs.
   - If the published release remains the reviewed source, download once, verify
     GitHub digest plus DMG checksum, mount, and compare bundle contents.
   - If local fixes are required, stop before presenting them as a published latest
     release; installation of an unreleased build requires an explicit decision
     about whether to publish first.
   - Verify: both Macs run the same intended bundle from `/Applications/Usage
     Meter.app`, with matching version/digests and live UI smoke tests.
8. Report the boundary clearly.
   - Separate confirmed findings, fixes, test/build evidence, published-release
     state, current-Mac state, and secondary-Mac state.
   - Include remaining Minor risks and anything not live-verified.

## Stop conditions

- Pause before reviewer dispatch so the user can review these prompts.
- Pause before a push, tag move, release, or PR because none is authorized yet.
- Stop before mutating the secondary Mac if its identity, checkout, installed bundle,
  or backup target cannot be resolved unambiguously.
