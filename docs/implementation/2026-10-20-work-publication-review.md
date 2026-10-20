# Original work publication review

Completed work has a separate internal review against a configured target.
Accepting the original task or downloading its artifact does not create this
review, and preparing or approving this review does not write files or execute
Git. The remaining producer and product-entry work stays in the
[original chain](../superpowers/plans/2026-10-20-work-review-publication-chain.md).

## Read actual target state

`GitRepositoryInspection.publicationTarget` is distinct from dirty-only
stage/unstage `freeze`. It reads clean files and absent new paths through the
existing operator configuration, private nonexecuting metadata context and
bounded no-follow file reader. It does not manufacture a working-tree edit.

The witness retains original repository/program identity, HEAD, index, relevant
attributes, selected byte hashes, sizes, modes, hashed file-stat facts and hashed
parent-directory identities. Missing parents are explicit observations, not
permission to create directories. Selected bytes are retained privately for the
review comparison; no host root or raw physical inode appears in the projection.
Actual Git metadata and selected path witnesses are checked again after awaits.
The workbench rechecks project ownership before returning an observation.

Case/normalization aliases, overlapping selections, private paths, directories
as file targets, hardlinks, symlink ancestors and nested repositories refuse.
Cancellation or a changed selected file, parent, repository, HEAD, index or
relevant attribute prevents a matching before-state witness. Configured hooks,
clean filters, fsmonitor, external diff and lazy network fetch are not activated.
The full repository snapshot is conservative: unrelated status/metadata drift
can also require a new review rather than an automatic rebase.

## Bind source and target in the original database

`WorkPublicationIntents` derives source bytes from `FinalizedWorkSources` in the
same database, never caller-supplied replacement content or a mutable tree. A
batch source selection resolves all original versions within one read boundary
instead of rescanning the complete proof chain separately for every file.
Only actual supported added/modified file paths from the frozen work diff may
be selected. Any unsupported source change refuses preparation; it is not
silently dropped from a partial result.

An existing target must match the original source base's exact bytes, size and
executable state. A new source path requires actual target absence. The review
contains the actual before text, exact reviewed result text, relative paths and
base/result facts. UTF-8 text is supported; binary, generated/shared producers,
rename/delete/mode changes and unimplemented structural directory effects need
their original provenance and producer integration before they can be published.

The immutable intent binds original source/candidate/certificate/inspection
facts, complete source digest, chosen paths, target witness and configuration
scope, review digest and physical WAL database identity. Copying the database
does not turn its old records into the original publication authority. The
constructor and historical reads perform no schema installation; the explicit
installer runs only during trusted bootstrap. It is not enabled in server
bootstrap or exposed through a new browser endpoint by this increment.

Prepare and approve collect physical state outside SQL transactions, then commit
only synchronous database facts. Source, ownership and configured target scope
are rechecked in the original commit. Duplicate request IDs recover their exact
immutable acknowledgement; different payloads conflict. Control inputs are
cloned before awaits, so later object mutation cannot change an approved command.
Read-only SQLite supports historical review without DDL, row changes or events.

## Explicit review lifecycle

Versioned `prepared`, `approved` and `cancelled` events are immutable. Approval
requires the exact current version and review digest and a fresh original source
and target observation. Changed source/target or revoked owner rejects approval.
Cancellation can revoke a prepared or approved review without touching files.
Historical command replay may return its original approved acknowledgement after
cancellation; `get` returns current state. Every projection still carries
`execution_authorized: false`; neither response is a producer dispatch grant.

The tables reject update/delete/replacement and invalid event sequences. A
review never creates a task, Goal, lease, model request, budget allocation or
artifact. It retains original uploads and delivery records.

## Verification and remaining work

Dedicated tests use actual local repositories and original isolated work,
inspection, owner acceptance, native completion and finalization. They exercise
clean/absent targets, exact before/result bytes, no index/file changes, case and
link boundaries, nested repositories, read races and cancellation, hooks,
HEAD/index drift, root replacement, source corruption, owner revocation,
immutable commands and records, read-only restart, copied databases and
two-connection idempotency. One source-corruption fixture was corrected to remove
its surrounding transaction: it now fails on the actual corrupted source proof,
rather than accepting an earlier async-transaction guard as sufficient evidence.

The combined original inspection/intent, historical source and new review
regression passed **55 tests** with no skips. The complete Gateway run finished
with **2,120 passed, 20 skipped, zero failures and zero cancellations** (2,140
total). All 594 enumerated source, test, contract, script, template and package
files matched their pre-run hashes and complete enumeration after the run.
Gateway typecheck/build, root tests (67), interface tests (253) and the local
frontend build passed. No remote build was used.

The stable post-suite source scan found no findings. Reachable history/index
review retained the unchanged known neutral Office binary findings, with no new
disclosure finding. Production, external-provider and native publication
acceptance are not implied by these local checks; existing platform/provider
skips remain separate from executed evidence.

Next, the original producer coordinator must consume the exact approved review
under project reservation, complete native-family maintenance and the original
Worker lease. Physical preparation, directory creation and each file publication
need immutable journals, acknowledgement and settlement/recovery evidence.
Recheck the saved target immediately before effects; approval is an observation,
not a filesystem lock. Unknown outcomes retain custody and never auto-replay or
claim rollback. Only after those paths pass should HTTP/mobile apply/current/
disposition controls and Git/checkpoint write activation be connected. The full
26-capability and portable Chat/Work scope remains open.

The original reservation schema currently constrains `operation_kind` to
`git_index`, and settlement resolves index-specific execution, outcome, producer
and finish rows. File publication needs a distinct typed operation through this
same coordinator, with an atomic, quiescent migration that preserves original
rows, hashes, member fences and foreign keys. It must not be cast as an index
operation or settled by unrelated Git receipts. The existing authenticated native
hosting must retain its complete family and original producer lifecycle for that
new operation; a second mutex table or approval-only shortcut would not close it.
