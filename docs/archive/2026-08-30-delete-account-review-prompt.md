# UsageMeter disconnected-account delete review

> **Historical review prompt — completed and superseded.** Preserved for provenance; it does not describe the current working tree.

Review the current uncommitted diff against base commit `c2774a0`.

## Requirement

When a previously known account is no longer logged in, UsageMeter must show no
cached usage and must offer compact **Sign in** and **Delete** actions. Delete
must genuinely remove the account from UsageMeter without signing the user out
of the main Claude Code or Codex installation.

## Implemented behavior

- Disconnected rows show Sign in and Delete; fresh rows keep usage limits.
- Delete requires confirmation, removes the config identity and cached usage,
  and synchronizes the renderer and Electron snapshot.
- Codex deletion removes every matching auth copy under UsageMeter's managed
  `~/.rate-limit-tool/codex-identities` root only. It does not touch `~/.codex`
  or other external auth homes.
- Explicit empty account configs remain empty so a deleted final Claude row is
  not silently restored.
- An in-process tombstone prevents a concurrent stale refresh write from
  resurrecting the just-deleted identity.

## Review focus

Return only high-confidence findings, ordered by severity, with exact file and
line references. Check:

1. accidental deletion of non-UsageMeter credentials or unrelated identities;
2. races among refresh, config persistence, IPC snapshot state, and deletion;
3. account rediscovery and empty-config behavior across restart;
4. renderer state, confirmation, error recovery, and button visibility;
5. tests that can pass while the real delete path is broken;
6. regressions to fresh Claude/Codex usage display or login behavior.

If no high-confidence issue remains, say so explicitly.

## Re-review after race fixes

The first review found two P1 races. The follow-up diff now:

- keeps full identity tombstones in memory and matches by provider id/email, not
  only the legacy local id;
- filters both stale config identities and rehydrated managed-auth identities;
- removes any matching auth copies recreated by an in-flight refresh before its
  queued save commits;
- increments an Electron account-mutation generation after deletion and
  reconciles older in-flight refresh snapshots against the current config before
  publishing them;
- adds targeted regression tests for tombstoned hydration and Electron snapshot
  reconciliation.

Re-review the complete current diff, including whether these fixes fully close
the original races without preventing unrelated accounts from refreshing.

## Final re-review after identity-collision fix

The second review found that a direct local-id tombstone shortcut bypassed the
conflicting-provider safeguard. `identityWasRemoved` now delegates entirely to
`identitiesMatch`, so two Codex entries with the same legacy local id but
different provider account IDs remain distinct. A regression test covers that
exact configuration. Re-check this fix and the complete diff for remaining
high-confidence issues.

## Re-review after unique-ID invariant

The third review found that the real removal helper still filtered every entry
sharing a legacy local id. Normalization now enforces unique local IDs after
identity merging, deterministically deriving a provider-based ID for a
collision. The real delete path uses a tested `removeIdentityFromConfig` helper
that removes one indexed identity only. Re-check the full implementation and
tests for any remaining high-confidence issue.

## Re-review after hydration uniqueness fix

The fourth review found that managed Codex-auth hydration did not reapply the
unique-ID invariant. `hydrateConfigFromStoredIdentities` now runs the merged
configured and stored identities through `makeIdentityIdsUnique`. A regression
test constructs a configured identity whose legacy ID collides with the derived
ID of an unrelated managed auth folder and verifies two distinct result IDs.
Re-check the complete diff once more.

## Installed-path auth-status fix

Native verification showed the installed Claude CLI writes its valid
`loggedIn: false` JSON to stderr when exiting with status 1. The parser now
checks both stdout and stderr and accepts only an object with
`loggedIn === false`; the targeted test covers both streams. Review this final
delta for incorrect error swallowing or login-state classification.
