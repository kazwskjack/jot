# Durable original Git index execution (internal)

The [Git workbench task 4](../superpowers/plans/2026-10-19-git-workbench.md) now
has an internal original execution journal and cross-process physical observer.
Neither the service nor its recovery methods are registered as HTTP routes or
DSH tools. Review API/UI capabilities remain read-only with respect to Git
effects. This does not complete the full Git capability or the product ledger.

## Original review and execution

Exact-review witnesses now use internal protocol 2 and bind applicable
`.gitattributes` hashes, including ignored and missing files. Snapshot IDs also
include these dependencies, so an old patch selection cannot survive an ignored
attribute change. Existing safe Git configuration and metadata checks remain.
Attributes are bounded and read twice. Legacy witnesses need a fresh review;
they cannot silently become executable after an upgrade.

Controlled copies preserve the source index and shared-index modification times.
Giving a copy a newer timestamp can disable the content recheck that detects
same-size, same-second edits, as described in Git's official
[racy-stat documentation](https://git-scm.com/docs/racy-git). The first full
regression exposed this actual missed-change case; a repeated diagnostic
reproduced it. A deterministic copy-timestamp regression verifies preservation
without changing source index bytes or timestamps. Refreshing the real index or
weakening the ignored-attribute assertion is not the fix.

`GitMutationIntents.executionSource` reads the original owner/project review,
approved version and digest. It recomputes that digest and permits only the
implemented stage/unstage actions. `GitIndexExecutions` admits a stable original
request bound to that intent, witness and repository. Caller bodies cannot
choose an owner, root, executable, action, lease or physical evidence.

The service uses the existing `ga_worker_leases` table and original
`assertExecutionLease` fence, with an internal `git-index:` repository resource.
There is no new planner or task scheduler. Current ownership, original approval
and lease owner/generation/expiry are checked before preparation, dispatch and
the final synchronous transaction. A heartbeat renews only a still-valid
original execution lease. Replacing or revoking that lease prevents the old
Worker from publishing. Unresolved dispatches exclude fresh requests against
the same repository even after the Worker lease expires.

Three private append-only tables retain the original request, dispatch evidence
and confirmed outcome. Triggers reject updates and deletions. Dispatch commits
before the first source object write; code refuses to run inside an already
open caller transaction that could roll this record back after a Git effect.
The original index is replaced and its outcome recorded in one final original
database transaction. A database rollback still cannot undo an index rename.
Original request replay returns its existing result rather than a new write.
Historical reads check current ownership; a later review cancellation does not
rewrite history or grant fresh execution permission.

## Cross-process observation and owned locks

The strict internal evidence record contains the original source digest,
repository/directory identities, exact index hash and owned index-file identity,
relevant ref hashes, bounded blob hashes/sizes and exact owned lock/parent facts.
It contains no executable plan, command, credential or operator root path.
The observer is reconstructed from trusted original storage and the configured
repository. Serialized JSON never becomes a writable plan.

An index matching the candidate hash is not sufficient. Its physical identity
must be that of the original owned index lock; refs, roots and referenced objects
must still match. Outside matching-byte replacements remain unknown. An unchanged
original index means publication was not observed, not that no object writes
occurred. Corrupt/missing objects cannot produce an applied receipt.

Recovery first obtains a new original lease, fencing the previous Worker. A
currently active lease prevents takeover. It records a confirmed original
outcome without reexecuting the mutation, then cleans only persisted lock files
whose identities and contents still match. The published index is never deleted.
New empty lock-parent directories require their original identities; foreign
contents or replacements are preserved. A known historical result remains
distinct from whether current workspace contents have since changed.

## Executed focused evidence

Actual temporary repositories and SQLite connections cover original result
replay/reopen, ownership revocation, immutable records, cancellation during
asynchronous preparation, active/replaced leases and the unresolved-dispatch
barrier. Injected outcome-write failure verifies that reconciliation preserves
the exact original index identity rather than writing it again.

Separate actual child processes exit with code 73 before publication and after
physical publication but before the database outcome commits. A new kernel reads
persisted evidence. The full executor crash fixture also confirms that the old
lease initially blocks takeover, that a controlled later clock permits a new
generation, and that recovery releases proven locks so a native ref operation
works again. These are real process exits, separate from simulated exceptions.
All fixture content is synthetic; no remote providers or production accounts
are involved. Complete regression/build/privacy publication gates are separate.

## Still open before execution admission

- A process can exit partway through conventional lock acquisition, before the
  complete dispatch evidence has committed. Do not delete those unproven locks
  or call them owned merely because they are old. Durable ownership must precede
  placement at conventional lock names, with actual crash coverage at each gap.
- A recorded pre-publication dispatch currently returns an observation without
  becoming an automatically retried mutation. Add an explicitly reviewed durable
  not-published/abandon disposition and owned-lock handling; unknown outcomes
  must continue to block blind fresh requests.
- API/BFF/shared-schema integration, original HTTP acknowledgement recovery,
  mobile execute/result controls and complete UI restart acceptance are pending.
- Rename scopes, commit, destructive operations, independent revert, remote
  operations and power-loss durability retain their own remaining requirements.

Follow the [durable execution plan](../superpowers/plans/2026-10-19-git-durable-index-execution.md)
without bypassing the original Session, permission, accounting or receipt chain.
