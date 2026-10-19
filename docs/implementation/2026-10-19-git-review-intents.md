# Exact Git review intents (in progress)

The subsequent [owned API increment](2026-10-19-git-review-api.md) connects this
journal to original authenticated HTTP acknowledgement transactions. The record
below describes the earlier internal foundation and its separate release scope.

This is an internal prerequisite for the local-mutation phase of the
[Git workbench plan](../superpowers/plans/2026-10-19-git-workbench.md), not an
enabled Git write feature. No API mutation route, model tool or dispatcher mounts
this module yet. The visible Git workbench remains read-only.

## Implemented boundary

`GitRepositoryInspection.freeze` reads the selected current paths under the
existing physical repository/snapshot checks. Its witness includes HEAD, index
digest and selected working-file byte hashes, sizes and modes; missing files
remain explicit. It returns no file bodies. Selections are limited to 100 paths,
32 MiB per file and 64 MiB total. The source index and worktree are unchanged.

`GitMutationIntents` stores the exact owner/project request, separate operation
kind, selected paths, original witness and review digest in an immutable SQLite
journal. Stage, unstage, commit, discard and untracked deletion have distinct
selection checks. A commit review must select all visible staged entries and
refuses any protected omitted path, so an unseen staged file cannot be silently
included. This does not establish commit execution semantics.

Approval requires the original review digest, expected version, current project
ownership and a fresh matching repository/file witness. Cancellation is versioned
but does not require unchanged source files. Append-only state events and exact
command request hashes provide original acknowledgement recovery. Replaying a
prior approval returns its original acknowledgement, even after cancellation;
the separate current-state read still reports cancelled. An acknowledgement is
not a new approval or execution grant. All projections retain
`execution_authorized:false`.

Ownership is rechecked after asynchronous reads and inside the final original
transaction. Duplicate preparations/control calls cannot create duplicate rows
or events. Database triggers reject changed original intents, rewritten/deleted
receipts, invalid sequence numbers and transitions out of cancelled state.

## Executed evidence

Nine new intent cases passed, together with fourteen actual-Git inspection and
six existing owner/API cases: 29 passed, no skips. TypeScript checking passed.
The new tests cover unchanged source index, exact request replay, lost-response
acknowledgements after a database reopen, cancellation, stale content/index,
wrong review hashes, foreign/revoked ownership, immutable SQL rows, operation
selection checks, protected staged files and concurrent duplicate calls.

The protected-staged-file regression first failed by accepting an incomplete
review, then passed after the guard was added. An initial restricted-Windows run
passed 27 cases and failed two directory-junction fixture creations with EPERM;
the authorized user-context rerun passed all 29 without changing permissions or
skipping those tests. This is not a new production filesystem failure.

## Still required

Wire original authenticated API/CSRF and atomic-command receipts; add actual
review/approval/cancellation UI; dispatch only from the current original approved
intent while revalidating all authority and byte witnesses; implement bounded
local writes, original outcome evidence and unknown-result reconciliation.
Cross-process/true crash boundaries and actual mutation effects remain untested.
Remote operations keep a separately approved frozen remote/ref and credential
reference, not this local review's authority. Full Gateway regression terminated
with 1,945 passed, seven existing conditional skips and zero failures (1,952
total). The Windows Gateway build passed before that complete run. The later
review-API TDD cases are a separate unfinished increment and were not part of
this completed suite or release scope.

The subsequent history/staged-index privacy review completed over 186 commits
and 2,829 distinct blobs. Its five findings match the already reviewed neutral
Office template objects exactly; there are no new findings from this increment.
This does not replace manual review or establish absence of arbitrary secrets.
