# Project Git inspection

The extended Gateway and workbench now provide an owned project repository view:
select a configured project, inspect branch/HEAD and changed files, open staged
or working patches, and refresh when the underlying files change. The standalone
runtime is a separate product path. Commit, discard and remote actions remain
open in the [full Git plan](../superpowers/plans/2026-10-19-git-workbench.md).

## Configuration and API

`GENERAL_AGENT_GIT_REPOSITORIES` defaults to `[]`. The operator supplies an array
of `{owner_id, project_id, root}` bindings, using an existing owned project and
an absolute repository path. Linked worktrees additionally require explicit
`git_directory` and `common_directory` mappings. One common metadata directory
cannot be bound twice. `GENERAL_AGENT_GIT_EXECUTABLE` optionally pins an absolute
Git executable outside the inspected repository. These values stay server-side;
the browser cannot select roots, executables or arbitrary Git commands.

The authenticated GET `/v1/projects/{projectId}/git` returns a snapshot. GET
`/v1/projects/{projectId}/git/diff` accepts only `snapshot_id`, a literal selected
`path`, and `stage=working|staged`. Ownership is checked before filesystem reads
and after awaited work. Both responses are private/no-store, read-only and
explicitly not execution authorization. Capabilities list only currently owned
configured project IDs. Remotes expose names, transport category and hostname,
never credential bodies or full URLs.

## Repository reads

The reader pins physical root, Git/common-directory and executable identities.
Metadata symlinks, changed witnesses, unsafe paths and nonempty alternates fail
closed. Index, HEAD, metadata and worktree file witnesses bind each diff to its
snapshot, including content edits that leave porcelain status unchanged.

`--no-ext-diff` and `--no-textconv` alone were insufficient: ordinary status and
diff can still attempt configured clean filters. Each inspection therefore uses
a disposable metadata copy with the original index/refs/object directory and
only allowlisted nonexecutable configuration. Source includes, hooks, filters,
credential helpers and arbitrary executables are not activated. Temporary copies
are cleaned up and source index bytes remain unchanged. No network operation is
provided. This is not an execution repository or a second authority store.

Reads bound subprocess output, duration, metadata traversal, changed entries and
patch size. Cancellation kills the owned child. Protected paths are omitted;
binary bodies are not rendered. Unborn/detached, conflicts, renames, deletions and
untracked changes remain explicit. Global Git configuration is deliberately not
inherited, so user-global filter semantics are not promised.

## Verification

- Full Gateway: 1,936 passed, seven existing conditional skips, zero failures
  (1,943 total). This includes fourteen actual-local-Git inspection cases, six
  ownership/API cases and synchronized contract regressions.
- Root: 67 passed. Full workbench/chat UI: 249 passed. The new actual mobile
  React/BFF/Gateway case uses a temporary repository at 390 by 844, opens real
  patches, rejects stale selection, and verifies no page-level horizontal overflow.
- Windows Gateway and Vite builds passed. The Gateway build ran after the
  complete Gateway suite terminated to avoid changing shared template fixtures
  mid-run; the independent frontend build completed separately.
- Chat prompt composition/tool boundaries: four portable and seven production
  adapter tests passed after the separate all-subject evidence-first prompt edit.

Fixtures cover hostile filters/configuration, directory replacement, linked
worktrees, cancellation, private paths, credential redaction, special filenames,
output/remote limits and unchanged source index. Windows symlink coverage uses
an actual directory junction; unsupported file-symlink creation was not counted
as a passing test or used to weaken operating-system settings.

These are local Git and scripted-provider workflow results. They do not prove
remote push authentication, production deployment, full Git parity, or completion
of the broader 26-capability plan.

Public preflight passed six scanner regressions and scanned 1,077 source files.
The reachable-history and staged-index review covered 184 commits and 2,819
distinct blobs. Its five findings are the exact previously reviewed neutral
Office template binary objects; none is a new finding from this increment.
This is a bounded heuristic review with separate binary provenance review,
not a claim that arbitrary secrets can be proved absent by pattern matching.


## Fixed commit review identity

A repository binding can supply `commit_identity` from operator configuration.
Both `author` and `committer` require an exact nonblank `name` and `email`.
For example, the additional binding field can be

```json
{"commit_identity":{"author":{"name":"Project Author","email":"author@example.invalid"},"committer":{"name":"Project Operator","email":"operator@example.invalid"}}}
```

The owner review records both identities with one server-captured UTC time at
whole-second precision, the complete UTF-8 message and digest, staged tree and
object format, parent, current branch or detached HEAD target, and identity-policy
digest. Approval recomputes the source proof and the configured identity policy
while retaining the original captured time. A changed policy requires fresh review.
Bindings without this field retain repository inspection and index operations.
Commit review requires the configured identity. Historical commit reviews remain
readable and cancellable, and require a fresh metadata-bound review for approval.
The physical repository exclusion namespace continues to derive from the original
common Git directory. The owner review and its version are the fixed source for the subsequent
original commit admission and effect work.


## Offline commit execution schema maintenance

The original index execution table can hold typed commit rows under protocol 5.
New stores create that schema. Existing canonical index stores retain their current
schema until explicit offline maintenance. Inspection reports `commit_execution_schema`.
The original project/family reservation and common-directory Worker namespace own
subsequent commit admission. Original journal readers handle protocols 1–5, with
commit rows bound to protocol 5 and the exact immutable metadata-approved review.

Stop Gateway, Worker and native pools before applying this table change. The
maintenance command checks the original physical WAL database, foreign keys,
quiescent original leases/runs/reservations/budgets/producers and native closures.
It preserves original execution rowids while copying rows transactionally, restores original views/triggers and
indexes, and compares all application-table row inventories and non-target schema objects.
Its result includes `offline_pool_drain_observed:false` because database evidence
cannot observe stopped idle native pools.

The existing maintenance entry supports these operator commands after compilation.

```text
publication-maintenance-main inspect ABSOLUTE_DATABASE
publication-maintenance-main apply-commit ABSOLUTE_DATABASE EXPECTED_DATABASE_SHA --confirm-offline
publication-maintenance-main rollback-commit ABSOLUTE_DATABASE EXPECTED_DATABASE_SHA --confirm-offline
```

The expected database digest comes from inspection. Rollback requires no commit
rows and no protocol-5-or-newer rows, including completed history. Original receipts
and rows are retained.

## Typed commit admission and pending history

The original admission endpoint now accepts metadata-approved commit reviews on
the typed schema. Its immutable receipt fixes the original target ref and expected
parent OID. Journal, status, history and browser readers retain these facts and
check the original review hash, witness hash, repository binding and approved
version. Current operator policy is checked again for a new admission. Historical
reads retain the frozen policy facts after configuration changes. Cached Git API
receipts recheck current project ownership before returning the original bytes.

A never-started commit admission can be explicitly ended through the existing
versioned control and not-dispatched receipt transaction. That path requires no
producer, native preparation, dispatch, outcome or workspace reservation. Original
index evidence cannot be interpreted as a commit receipt. Native commit preparation, writing and explicit unknown-effect settlement now use
the original execution service as described below. Public commit dispatch follows the project-scoped configured capability. The browser shows retained commit admissions and their
pending, closed or typed applied state.

This increment was developed by source inspection only. No test, build, migration,
native command, UI acceptance or deployment was executed.


## Private commit object material

The configured Git kernel now derives host-private commit material from an exact
metadata-approved review. The original isolated metadata context recomputes the
reviewed staged-tree evidence, enumerates only its tree graph and reads bounded
raw tree objects in one batch. Each raw object is verified with the repository's
SHA-1 or SHA-256 object hash. Existing blob evidence encoding is retained.

Commit headers use the frozen author, committer, whole-second UTC times, tree
and optional parent. The UTF-8 message bytes retain their original final newline
state. The commit object is written and read back only in the disposable private
object directory. It has no source alternates for that write. All private context
cleanup runs in finally, and current project ownership and identity policy are
checked before and after preparation in the host service.

The material is retained in the kernel. Host callers receive a frozen one-attempt
plan, and persisted JSON cannot reconstruct writable plan identity. The original native Host and execution service consume the plan without exporting
its private buffers. Original repository objects, index and refs are untouched by this
preparation path. Public commit dispatch follows the project-scoped configured capability. This source increment
has no runtime, test, build or native-command execution evidence.


## Commit object lock protocol

The commit kernel now retains the original source index bytes, selected files and
attributes, raw HEAD/branch/packed-ref facts, metadata and physical directory
identities throughout object writes. It reuses the existing index kernel's source
checks, parent creation, isolated command transport and owned-lock cleanup core.
Existing index preparation/evidence decoders still validate their original format.

Commit-specific evidence binds the reviewed metadata and source digests, exact
commit/tree object IDs, body digests and sizes, target ref, parent, physical roots,
lock identities and created ref parents. The kernel creates private pending lock
files, requires synchronous durable preparation before canonical lock installation,
and installs each canonical lock with an exclusive hard link preserving its
journaled inode. The original coordinator supplies the acquisition transaction,
dispatch journal, owner/lease/native-custody checks and cleanup transaction.

The index lock contains the unchanged original index bytes. HEAD, packed refs and
the original branch remain locked while reviewed tree/commit objects are written
through the isolated metadata configuration and read back from the original object
store. Cancellation, proof changes or cleanup uncertainty consume the in-process
plan. Owned pending/canonical pairs are checked before removal. Foreign files,
unknown links and replaced roots are retained for explicit recovery.

A host-only publication continuation runs inside those locks. The configured
kernel now supplies ref CAS, reflog facts and read-only observation as described
below. Original execution-service journal consumers and native recovery now use this
proof. Public commit dispatch follows the project-scoped configured capability. No runtime command,
test, build, migration or production operation was executed for this increment.


## Original ref and reflog publication

The host-only `applyCommit` path keeps the existing index, HEAD, packed-ref and
branch locks through object writes and the following publication. It verifies the
reviewed old target and rejects a changed HEAD or unsupported symbolic branch.
The reviewed committer identity and UTC time supply deterministic HEAD/branch
reflog entries. Original log bytes are retained as an exact prefix.

Separate pending files hold the new reflog bodies and new ref OID. Publication
preparation records their exact inodes, hashes, sizes and modes, all old file
facts, the reviewed old/new OIDs and the remaining metadata digest. Synchronous
original coordinator callbacks persist preparation before canonical reflog locks
are installed and wrap publication in the original effect/outcome transaction.
Each staged file is fsynced and each canonical reflog lock uses an exclusive hard
link. Reflogs publish first and the original branch or detached HEAD publishes last.
The unchanged conventional ref/HEAD locks remain held throughout.

Source guards exclude only these exact managed paths from the metadata digest.
Their identities, bytes and stats are checked separately before each rename. The
kernel updates expected facts only after verifying the newly installed owned inode.
A partial publication remains an unknown effect. Cleanup removes only exact owned
pending/lock files, preserving published refs/logs and original content-addressed
objects. Ref-log cleanup precedes original index/ref lock cleanup.

Read-only observation checks the original physical roots, program binding, remaining
metadata, index and every old/new ref/log fact. A complete new state also requires
the actual commit object and full reviewed staged-tree/blob evidence to match.
Partial states remain unknown. This observation grants no producer/lease authority
and reconstructs no writable plan.

The original execution-service journal, typed applied receipts, native custody
consumers and explicit settlement are connected as described below. Public commit dispatch follows the project-scoped configured capability. This increment has source and Git-delivery evidence only.
Tests, typechecks, builds, native commands, migrations and deployment were not run.


## Original execution and native consumers

Commit effects now run from the original `performReserved` path in operation kind
`git_index`, protocol 5, physical database and common-directory Worker namespace.
The original reservation/family source, native admission, root association, producer
start/finish and lease heartbeat remain in force. A commit requires an existing
immutable admission and live host-private native custody before producer start.
Plain execute/reconcile/abandon entry points cannot grant commit write/recovery rights.

Object preparation and dispatch use the existing original journal tables. The
append-only `wb_git_index_ref_preparations` phase table references the original
execution ID and records ref/reflog preparation before publication. It has original
immutable, no-disposed, no-applied and typed-commit-only guards. It provides no new
operation registry or scheduling authority. Native Host startup still refuses any
schema or application-row installation during its readiness transaction.

Readers bind every commit phase to the original producer lease, exact immutable
approved review/version, metadata digest and deterministically derived commit
bytes. Applied results expose the original target/parent and exact commit/tree OIDs.
Original stage/unstage receipt bytes and state-hash encoding remain intact. Commit
histories without the optional ref phase retain their previous state-hash encoding.
The original contracts include the commit applied branch in status/history/control
results, and the BFF retains private/no-store for Git responses.

The original native control path observes ref/log/object facts with fresh custody,
records only the original outcome, cleans the ref phase before object locks, and
settles the original reservation after the native Host's final check and drain.
It never creates another commit or a replacement producer finish. Transfer/revocation
and changed-root handling remain constrained by the original owner/native fences.
The audited recovery and public commit review/admission/dispatch entry points
are described below.

Native operator repository bindings accept `git_directory`, `common_directory` and
exact `commit_identity` fields under the same policy rules as Gateway. Optional
`gitExecutable` selects the same absolute Git program. Both processes must use
matching bindings and identity policy for the original reviewed witness.

This is development-only source delivery. No test, typecheck, build, SDK/native
command, migration, UI acceptance or deployment was run.


## Scoped public commit workflow

`git_workbench.commit_projects` identifies current-owner repositories with the
original native transport, typed commit storage and configured operator identities.
The field is omitted when those conditions are absent. Original index capability
and readonly shapes remain valid. Every native effect repeats the original owner,
review/version, identity-policy, lease, physical database and custody checks.

The public workflow shows all server-reviewed staged paths, the complete message,
identities and times, parent/target and tree/object format. Approval enables an
explicit admission button. Successful admission exposes a separate dispatch button.
Original request retries and restored admission hints confirm the saved receipt.
Atomic commands share the original terminal-rejection predicate. A confirmed
rejection clears the component command together with its receipt hint, so a fresh
state read and owner confirmation use the new version. Network loss, 408, 5xx and
idempotency-in-progress retain the original pending command.
The same original history discovers pending and completed operations after reload.
Applied views display the actual commit/tree OIDs and original target/parent.
Legacy metadata-less reviews remain cancellable.

Review text describes approval state separately from execution status. Completed
control receipts with unverified lock cleanup keep that fact visible. Long branch,
identity and hash values wrap in the existing mobile layout. Commit selection
uses the original complete staged selection and 100-path review limit.

## Recovery source audit

The original producer start/finish journal, native family source and resident/cold
barriers remain on the public commit path. Before new native effects, an interrupted
producer blocks the startable predicate. Applied/unknown effects read through the
same original journal on retries. Lost responses use original acceptance/history
and explicit control receipts. The family barrier holds factory admission plus
resident maintenance or cold persistence handles, and checks source membership,
inbox/tool/remote closure and native signals through the awaited operation.

Root, ref, index, lease and owner changes meet the original guards at each phase.
Ref/log/graph observation classifies exact old/new facts and preserves partial
states as unknown. Original owner loss fences further access/effects and retains
its namespace and records. Recorded original drain evidence remains internally
readable for maintenance after transfer. Current ownership and the configured
original binding are prerequisites for fresh explicit recovery. Published effects
and existing producer finishes retain their original lineage.

P08 source development is connected through React, BFF, Gateway, original local
transport and the installed SDK Host composition. This delivery includes source
inspection, paired contract-object comparison and Git publication. Tests, builds,
SDK execution, UI rendering, migration and production acceptance were not run.
