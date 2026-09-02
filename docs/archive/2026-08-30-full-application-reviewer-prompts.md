# Usage Meter Reviewer Prompts

> **Historical reviewer prompts — completed and superseded.** Preserved for provenance; the pinned revision and assignments are not current instructions.

## Shared prompt sent to every reviewer

You are one of 20 independent reviewers of the Usage Meter macOS Electron app.
Review the Usage Meter repository, pinned to remote revision
`01e0f59f839691b490e884162121378d871637cd` unless the coordinator gives you a
newer fetched SHA. This is a read-only code review: do not edit files, install
anything, run action-capable optional automation, commit, push, publish, or send
data. Existing untracked planning files are out of product scope.

Read the implementation, relevant tests, and documentation for your assigned
role. Prioritize the user's four goals: correct behavior, absence of realistic
bugs, good UX, and organized maintainable code. Avoid style-only comments,
speculative hypotheticals, dependency-version trivia without a concrete failure,
and broad refactor requests.

For every finding, return:

1. Severity: Critical, Important, or Minor.
2. Exact file and line range.
3. Concrete failure mode and affected user path.
4. Why the existing code/tests do not prevent it.
5. The smallest credible reproduction or regression test.
6. The smallest safe fix direction.

State explicitly when you found no actionable issue. Distinguish source-only
concerns from behavior you actually reproduced. End with the exact files and
commands inspected. Do not write a review file; return findings to the
coordinator.

## Reviewer assignments

1. Architecture and boundaries
   - Model: `gpt-5.6-sol`, effort: high.
   - Trace shell, Core, server, preload, renderer, worker, updater, and persisted
     state boundaries. Find circular responsibility, duplicated source of truth,
     or packaging/runtime divergence that can cause a real defect.

2. Electron main-process lifecycle
   - Model: `gpt-5.6-sol`, effort: high.
   - Review windows, tray, shortcuts, app activation/quit, launch-at-login,
     macOS Spaces, renderer lifetime, and resource cleanup.

3. IPC, preload, and renderer trust boundary
   - Model: `gpt-5.6-sol`, effort: high.
   - Review channel contracts, input validation, context isolation, sandboxing,
     navigation, external-link behavior, injected markup, and privilege exposure.

4. Codex transcript parsing
   - Model: `gpt-5.6-sol`, effort: xhigh.
   - Audit cumulative snapshots, resets, retries, partial JSONL, tool/event shapes,
     model attribution, call counting, and duplicate/missing token risks.

5. Claude transcript parsing
   - Model: `gpt-5.6-sol`, effort: xhigh.
   - Audit streaming revisions, resets, zero/nonzero transitions, caches, partial
     JSONL, timezone behavior, model attribution, and call counting.

6. Incremental filesystem index
   - Model: `gpt-5.6-sol`, effort: xhigh.
   - Audit append offsets, tail validation, truncation, replacement, in-place
     rewrites, symlinks, race windows, file disappearance, and zero-read claims.

7. Identity, deduplication, migration, and retention
   - Model: `gpt-5.6-sol`, effort: xhigh.
   - Audit rename/copy/delete cases, structural identities, v2/v3 migration,
     retained deleted sessions, fallback identities, and 90-day aging.

8. Worker concurrency and timeout behavior
   - Model: `gpt-5.6-sol`, effort: xhigh.
   - Audit utility-process spawn/message/error/exit order, serialization, timeout,
     cancellation, hung workers, overlapping refresh/repair, and stale results.

9. Persistence and crash consistency
   - Model: `gpt-5.6-sol`, effort: high.
   - Review atomic writes, temp-file cleanup, corruption recovery, permissions,
     schema/version handling, partial disk failures, and concurrent readers.

10. Codex/Claude provider integration
    - Model: `gpt-5.6-sol`, effort: high.
    - Review CLI discovery, authentication state, subprocesses, timeouts, output
      parsing, provider failures, stale-value merging, and recovery UX.

11. Limits, windows, pricing, and runway math
    - Model: `gpt-5.6-sol`, effort: xhigh.
    - Audit allowance resets, DST/timezones, five-hour/weekly windows, unknown
      models, pricing/cache math, projections, alerts, and boundary conditions.

12. Popover UX and accessibility
    - Model: `gpt-5.6-terra`, effort: high.
    - Review empty/loading/error/stale/offline states, keyboard use, focus, labels,
      contrast, scaling, narrow layouts, feedback, and destructive actions.

13. Usage History UX and visualization correctness
    - Model: `gpt-5.6-terra`, effort: high.
    - Review 7/30/90-day switching, chart/table consistency, tooltips, no-data and
      partial-data states, project/model grouping, Diagnostics, and repair flow.

14. macOS packaging and native integration
    - Model: `gpt-5.6-sol`, effort: high.
    - Review arm64 assumptions, DMG/ZIP contents, Info.plist, signing, login item,
      LSUIElement behavior, Spaces/fullscreen visibility, paths, and permissions.

15. Core updater and rollback
    - Model: `gpt-5.6-sol`, effort: xhigh.
    - Audit manifest signature/version compatibility, download integrity, path
      traversal, atomic activation, health confirmation, rollback, and downgrade.

16. Release workflow and version consistency
    - Model: `gpt-5.6-sol`, effort: high.
    - Audit package/lock/tag/release alignment, Actions workflows, artifact checks,
      recovery mode, secrets assumptions, reproducibility, and install guidance.

17. Test-suite quality and missing regressions
    - Model: `gpt-5.6-sol`, effort: high.
    - Map requirements to tests, inspect mocks for false confidence, identify
      nondeterminism and untested realistic failures, and run safe focused tests.

18. Performance and resource usage
    - Model: `gpt-5.6-sol`, effort: high.
    - Review scan complexity, memory retention, payload sizes, timers, worker and
      BrowserWindow cleanup, large-history behavior, and refresh amplification.

19. Error handling, privacy, and operational safety
    - Model: `gpt-5.6-sol`, effort: high.
    - Review secret/transcript exposure, logs/diagnostics, file permissions,
      subprocess arguments, network requests, user consent, retries, and alerts.

20. Adversarial end-to-end and organization pass
    - Model: `gpt-5.6-sol`, effort: xhigh.
    - Trace first launch, disconnected providers, normal refresh, History,
      Diagnostics repair, update/restart, failure recovery, and quit/reopen.
      Challenge assumptions from all modules and report only concrete defects or
      organizational problems that materially increase bug risk.

## Re-review prompt

Re-review only the coordinator's reproduced finding and its minimal local fix.
Confirm the original reproduction fails on the pinned base and passes on the
working tree, inspect the exact diff plus adjacent invariants, and run the focused
test. Report regressions or remaining Critical/Important issues with exact
file:line evidence. Stay read-only and do not broaden the review.
