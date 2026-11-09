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
uses the original complete staged selection and 5000-path review limit.

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

## Original branch execution storage preparation

The original wb_git_index_executions table has an explicit branch schema flavor.
It retains existing stage/unstage/commit rows and adds create-branch under
protocol 6. Commit remains protocol 5. Existing stores retain their current
constraints during normal Gateway or SDK construction. Explicit maintenance
uses the original physical database digest and offline confirmation.

```text
publication-maintenance-main apply-branch ABSOLUTE_DATABASE EXPECTED_DATABASE_SHA --confirm-offline
publication-maintenance-main rollback-branch ABSOLUTE_DATABASE EXPECTED_DATABASE_SHA --confirm-offline
```

The original migration preserves rowids, all application row inventories,
indexes, views, triggers and foreign keys in the same transaction. Branch
rollback targets the commit schema and refuses any create-branch or protocol-6
history. The existing commit-upgrade command preserves an already upgraded
branch schema. Legacy rollback retains its original commit/history restrictions.
Commit capability and commit admission recognize both commit and branch schemas.

This delivers storage preparation source. Branch admission, typed effect readers,
native creation/ref/HEAD/reflog publication and interrupted recovery remain in
M15.14. Development used source review only. Maintenance commands, migrations,
tests, builds and runtime acceptance have not been executed.

## Original create-branch admission and read-only state

The existing Git admission endpoint accepts an approved create-branch review on
the explicit branch schema. The original immutable execution/admission tables
retain owner, project, intent, request, review version/hash, source witness hash
and repository binding. A branch receipt fixes its complete new ref, target OID
and previous HEAD. Current review authority is required for a new admission.
Historical reads retain exact approved original facts after review cancellation.

The original status, inspection, history and control receipt contracts include
branch pending and closed results. The workbench history checks exact branch
facts and presents them as read-only. The original never-started confirmation
can close only an admission with no reservation, producer or effect records.
Existing branch admissions also participate in original pending-work exclusion.

Branch effects still require native kernel work. Public dispatch and direct
host execution reject create-branch before reservation, producer or lease start.
A preparation, dispatch, ref-publication or outcome record outside the supported
branch reader phase remains unavailable. Source review parsing is shared with
journal-only readers and preserves its original hash encoding.

The next increment must freeze configured reflog actor/time/log policy, connect
original native custody and implement HEAD/ref/reflog publication plus recovery.
Legacy reviews/admissions must remain readable and cancellable when richer
execution metadata is introduced. Source review only, with no test/build/native
or maintenance command execution in this increment.

## Frozen branch reflog metadata

New create-branch reviews use witness protocol 2. The original read context
captures effective common/worktree log configuration and bounded hashes/sizes
of the original HEAD and target branch logs, then rechecks source metadata.
Git parses configured boolean values, including valueless and numeric forms.
Worktree configuration enablement also uses Git's canonical boolean parser.

The operator-bound commit identity configuration supplies the branch committer.
The review freezes one UTC whole-second timestamp, committer-policy digest,
log-witness digest and explicit HEAD/branch append decisions. Approval and new
admission compare the current configured committer using the original time.
Journal-only readers validate frozen facts without loading current identity
configuration. Original protocol-1 reviews and admissions retain their original
hash and receipt bytes. They remain readable/cancellable, while new approval
or admission requires a fresh metadata-bearing review.

Existing log files participate in append decisions even with automatic log
creation disabled. Dangling unborn symbolic targets skip log appends. These
rules follow Git's documented log behavior and files-backend symbolic target
handling. [Git update-ref](https://git-scm.com/docs/git-update-ref),
[Git configuration](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corelogAllRefUpdates),
[Git files backend](https://github.com/git/git/blob/master/refs/files-backend.c).

Optional metadata is carried through original review, acceptance and pending/
closed result contracts and shown in read-only history. Branch name validation
maps an isolated check-ref-format rejection to the explicit invalid-branch error.
Native creation/ref/HEAD/reflog effects and recovery remain required. This
increment used source review and contract-object comparison. Tests, builds,
SDK/native/product commands, migrations and UI acceptance were not executed.

## Private automatic tracking configuration plan

Branch review now derives automatic tracking configuration in the original
private Git context. It copies relevant branch/remote-fetch data with duplicate
and valueless entries, including enabled worktree configuration. Git performs
the private branch operation at the exact HEAD. The original commit body is
read and verified with its object-format hash, and the private resulting ref
must contain that exact OID. Unborn HEAD produces its separate zero-ref case.

Only generated new-branch remote/merge/rebase changes are applied to a standalone
copy of the original common config. The planner rejects changes to other active
configuration entries and limits the resulting config to the existing 1 MiB
read bound. Exact common-config before/after hashes and change state join the
original witness and metadata. Raw config and source URL values stay private.
The active private config receives relevant tracking data through quoted data
sections. Full source config is used only by the fixed no-includes config parser.
The operation uses the existing isolated transport and source object alternates.

The new optional configuration witness preserves historical protocol-1/2 record
reads and cancellation. A new approval/admission requires the configuration
proof. Source metadata is rechecked after private planning and disposal. History
shows the configuration review digest and planned tracking updates. Git's branch
implementation sets automatic remote/merge/rebase configuration from its existing
tracking policy. [Git branch source](https://github.com/git/git/blob/master/branch.c),
[Git remote mapping source](https://github.com/git/git/blob/master/remote.c).

Actual source config/ref/HEAD/reflog publication, original native custody and
interruption recovery remain in M15.14. This increment used source review and
contract-object comparison, with no tests, builds, SDK/native/product commands,
maintenance commands, migrations or UI acceptance executed.

Private simulation restores its original active config and removes its generated
private ref/worktree config before the original source snapshot is read again.
The surrounding original context disposal owns all remaining private scratch.

## Create-branch original native publication

The original GitWorkbench now owns GitBranchEffects, retaining inherited index,
commit and publication entry points. Branch approval also prepares the exact
private configuration/ref/HEAD/reflog material under the current configured
committer policy. Actual execution obtains a fresh in-process one-use plan.
Raw config and log bytes remain private.

The original preparation and dispatch tables record strict branch envelopes
under the existing protocol-6 execution. Original producer lease lineage,
review/witness/metadata digests, root and .git identities, unchanged index,
packed refs and source branch, exact file before/after facts and owned lock
identities remain bound together. Preparation is durable before canonical
locks are occupied. Exclusive hardlinks retain the recorded pending inode.
Configuration, logs and the new branch ref publish before HEAD. No source
objects or working/index content are written by branch creation.

Original dispatch now enters the existing authenticated native host, sealed
workspace family and Worker lease. An applied receipt and producer finish
precede the native host's final checks and handle drain. Reservation settlement
uses the same original journal. Interrupted recovery obtains fresh native
custody and observes the original files, log prefix/suffix and commit OID.
A partial file prefix remains unknown. Explicit recovery cleans only the exact
owned pending/lock inodes and parent directories, preserving canonical files.
Recovery does not replay the mutation or manufacture an original producer finish.

Applied branch results join the shared result/status/control/history schemas.
History shows their preparation digest. New/legacy review compatibility remains
as described above. Initialization, switching/deleting existing branches and
creation/recovery UI remain in M15.14. This source increment did not execute
tests, typechecks, builds, product/native commands, migrations, deployment or
UI acceptance. The production schema still requires its explicit offline
branch upgrade before protocol-6 admission.

## Create-branch review and recovery UI

The branch list opens a project/snapshot-scoped creation review. It displays the
fixed new ref and starting OID, original HEAD, committer/time, log decisions,
automatic tracking configuration digest and review digest. Approval and
cancellation use the existing original branch-review routes. Historical reviews
without complete metadata remain readable and cancellable.

GitIndexOperation now also handles branch acceptance, explicit dispatch,
review cancellation and confirmed recovery. It retains the original index and
commit paths and callbacks. Branch acceptance, review and status must agree on
the original project, intent, request, branch/ref/OID, HEAD and frozen metadata.
Creation requires separate approval, admission and explicit native dispatch.
Recovery of an atomic admission response performs read-only reconciliation.
Successful applied and settled creation refreshes the repository snapshot.

Original owner/project-scoped command storage now accepts only the additional
branch-review prepare/control shapes. It retains the same request ID, body and
HTTP receipt key for unknown responses and reload recovery. Listing stored
requests and reading history never dispatch effects. History can open the same
original operation component for branch status, cancellation and explicit
recovery. Its original metadata and cleanup-unverified display remain available.

The server advertises optional branch_projects only for current owned project
bindings with a configured actor, native Git client and installed branch schema.
Older capability callers retain their existing defaults. The shared capability
contract and JSON/YAML source definitions include the optional branch project
list and prohibit it for read-only capability. Existing branch admission and
native owner/review/lease/custody checks remain authoritative.

Initialization, existing-branch checkout/deletion and remaining P09 operations
continue under M15.14 and their original IDs. This increment is source development
only. Tests, typechecks, builds, native/product execution, UI rendering,
migrations and deployment were not executed.

## Initialization source review

The original repository inspection now reads initialization state without
requiring an existing .git directory or discovering an ancestor repository.
The public git_present flag reports metadata presence. It carries no repository
health or effect assertion. An absent-metadata snapshot binds the configured
root, physical root identity, canonical Git executable/program facts and the
existing .pilotdeck directory/internal-ignore file facts. Symlinks, hardlinked
ignore files, root/program changes and unsafe initial branch paths are rejected.

New initialization review requests explicitly choose initial_branch and
object_format. The source freeze repeats the original absent-metadata snapshot
around fixed check-ref-format validation and computes the internal-ignore
before/after digest and size. The upstream final-effective-rule behavior is
preserved while retaining original bytes. Attribution and the existing upstream
license are recorded in THIRD_PARTY_NOTICES.md.

GitInitializationIntents uses the original immutable Git review/event tables.
Its prepare/approve/cancel routes join the same owner-scoped HTTP atomic receipt
protocol, cancellation and no-store handling. Approval repeats the full original
source witness. Current-owner checks also cover cached receipts. Legacy file
and branch readers keep their existing action scopes. Initialization admission
returns an explicit unavailable result until its original native effect phase
is implemented.

The status, prepare and review contracts have paired JSON/YAML definitions and
operation records. Existing workbench read clients expose the new status and
review read paths. Native initialization, exact-owned Git-directory and internal
ignore publication, interruption recovery and initialization UI remain required.
Existing metadata/reinitialization and linked/external binding semantics remain
in full M15.14 scope, followed by existing-branch checkout and safe deletion.
No test, typecheck, build, SDK/native/product operation, migration, deployment or
UI acceptance was executed for this source increment.

Git's initialization interface provides explicit initial-branch and object-format
options. Its native setup probes filesystem/configuration behavior, which must
be retained by the following actual-target-volume preparation phase.
[Git init documentation](https://git-scm.com/docs/git-init),
[Git native setup source](https://github.com/git/git/blob/master/setup.c).

## Initialization original storage and admission

The original execution table has an explicit initialization schema flavor with
init constrained to protocol 7. Offline apply-init and rollback-init use the
existing physical database identity, original maintenance/quiescence guards,
full application inventory, rowid preservation and foreign-key checks. Existing
commit/branch upgrades retain an installed initialization flavor. A downgrade
refuses any initialization/protocol-7 history, including closed original rows.
Constructors recognize installed initialization storage and preserve its schema.

Approved initialization reviews can enter the original atomic admission route
and original execution/admission namespace after the explicit storage upgrade.
Current owner, latest approval/version/hash, immutable witness/repository digest,
configured binding, original request ID and pending-work exclusion are retained.
Initialization receipts carry the original branch, object format and reviewed
internal-ignore facts. Legacy index and commit receipt property ordering and
encoding remain unchanged. Shared initialization readers are query-only and
never install tables or infer current owner authority from an old approval.

Original status/history/control contracts include initialization pending/closed
results. The never-started confirmed control closes only the same original
request with no reservation, producer, preparation, dispatch or outcome facts.
It needs no native handles and records not_dispatched with not_attempted cleanup.
Unfamiliar initialization effect records are refused until typed native phases
exist. Dispatch, direct execution, reservation and effect-bearing recovery remain
explicitly gated at their original entry points.

History displays scoped initialization facts through the existing Git operation
component. It can cancel the original approval and acknowledge/close a never-
started acceptance. The same owner/project request store persists cancellation
and original confirmation requests for response-loss/reload recovery. Restoring
those requests reads the original review/acceptance and requires explicit
confirmation before physical recovery. No initialization execution capability
or automatic dispatch is advertised by this increment.

Actual-target-volume private Git preparation, exact-owned metadata/internal-
ignore publication, original native custody/lease/producers, root/binding
transition, interrupted effects and initialization creation UI remain required.
Existing metadata/reinitialization, linked/external binding, branch checkout/
deletion and reference backend coverage remain in full M15.14 scope.
This source increment ran no tests, typechecks, builds, maintenance commands,
migrations, native/product operations, deployment or UI acceptance.

## Initialization private kernel source increment

The original GitWorkbench factory now retains GitInitializationEffects through
its existing branch/commit/index inheritance. Initialization approval invokes
read-only private plan preparation, repeating the reviewed source, explicit
initial branch, object format and internal-ignore byte facts. Only the retained
in-process one-use plan can enter applyInitialization.

The private kernel allocates a protected directory directly under the bound
root. Preparation records its identity and empty lock inodes before private Git
starts. Fixed arguments select an empty template, the reviewed branch and object
format, and the files reference backend. Existing readGit environment and process
drain controls apply. Git probes the target volume and generates configuration.
The temporary core.worktree value is removed and generated configuration is
restricted to initialization settings before publication evidence is recorded.

Synchronous authority callbacks bracket preparation, exclusive lock acquisition,
dispatch, publication and cleanup. Canonical directories are exclusively created
and pinned. Configuration and internal-ignore publication precede HEAD. Canonical
metadata receives the native directory modes and private file links are removed
immediately after installation. Serialized evidence records the exact generated
file identities, hashes, sizes and modes, plus private directory identities.

Read-only observation reports applied only for the complete original file facts
and exact expected directory layout. Partial effects remain unknown. Cleanup
requires original root/program and allocated namespace identities, exact empty
lock facts and a bounded regular-file scan. It removes private files and empty
private directories while preserving canonical Git and project ignore contents.
The exact allocation and root-lock names are protected by workspace path policy.

The apply/observe/cleanup kernel is not yet connected to original protocol-7
native execution. Typed preparation/dispatch/outcome readers, original native
custody, lease/producers, settlement and repository binding handover remain to
be connected before public dispatch is enabled. Initialization capability and
creation UI, reinitialization, linked/external bindings, branch checkout/deletion
and reference backend coverage remain in full M15.14 scope. This increment is
source development only under the user's no-test/no-build instruction.

Git initialization argument and generated configuration behavior follows the
[official init documentation](https://git-scm.com/docs/git-init) and
[Git setup implementation](https://github.com/git/git/blob/master/setup.c).

## Initialization typed journal source increment

The original preparation table now has a strict initialization reader for the
allocated private namespace. The original dispatch table reader validates the
full generated-file evidence against that exact preparation, immutable approved
source, execution/review digests and original producer lease owner/generation.
Protocol-7 producer records use the existing producer and finish namespaces.

Initialization outcomes retain an exact host-private wrapper in the original
outcome row. It binds the execution/request, public applied receipt and original
publication proof. The publication decoder checks evidence digest, fixed directory
paths/modes, unique physical identities and the original internal directory when
one existed. The public receipt contains the reviewed initialization facts and
evidence SHA-256. Physical root and directory identities stay in the private proof.

Original status/history readers now distinguish pending, unknown after preparation
or dispatch, and a strictly proven applied outcome. Applied and acknowledged closed
outcomes cannot coexist. Shared applied/resolution settlement readers recognize the
original protocol-7 record and use initialization-specific preparation/dispatch
facts. Reading them still requires the original native drain path before release.

The applied contract is paired in JSON/YAML and nested result, inspection, control,
status, resolution and history schemas. The original history/operation UI shows the
applied evidence digest. Existing index/commit/branch receipt layouts are retained.
Source-object comparison covered eight changed schema definitions.

The original native writer and effect-bearing recovery still require connection,
including outcome insertion, original custody/family/lease/producer lifecycle,
interrupted observation/cleanup, settlement and trusted physical binding handover.
Public initialization dispatch remains gated. Initialization creation UI and full
reinitialization/linked/external/checkout/deletion/reference-backend scope continue.
This increment followed the user's development-only instruction without runtime
verification, tests, typechecks, builds, migrations or deployment.

## Initialization original native lifecycle source increment

Original protocol-7 admissions now enter the existing reservation and sealed
workspace family. performReserved retains the original host-private custody,
root association, native admission and placement checks. executeOriginal requires
that custody and the original admission before preparing an initialization plan.
The same original Worker lease and producer bracket the entire write attempt.

Preparation records the private allocation before native Git runs. Acquiring
locks checks that original preparation inside the existing immediate transaction.
Dispatch records the generated metadata evidence. Publication checks that exact
dispatch and inserts the strict public/private initialization outcome wrapper in
the original outcome table. Producer finish reads initialization-specific phases.
Existing native host code delegates to this same execution service and preserves
its physical database lineage and final native handle drain behavior.

Explicit original recovery now observes initialization effects, records a proven
applied outcome when appropriate and cleans the original allocated scratch and
empty locks. Partial effects remain unknown and use the existing acknowledged
disposition. Recovery retains the original control and held Worker lease through
native final checks and handle drain. Both newly generated and cached applied
control receipts confirm physical binding under that fresh recovery authority.

The initialization kernel installs the original physical repository hash encoding
for the exact published root/.git and original program. Gateway cache adoption
reads the original admission/outcome and requires released_settled with its
existing producer/native drain proof. It rechecks current ownership, configured
exclusion binding, immutable outcome and physical root/.git/program identities
before adopting the new cache binding. Dispatch/recovery and settled retries call
that owning-service method. The owning service supplies the physical facts and authority.

The original HTTP dispatch/recovery routes now carry initialized operations through
the authenticated native client. Admission still requires the installed explicit
initialization storage flavor. Initialization capability and creation UI remain
the next increment. Existing metadata/reinitialization, linked/external bindings,
local/remote checkout, merged-safe deletion and reference backend coverage remain
in full M15.14 scope. This increment is source development under the user's
no-test/no-build instruction, with runtime behavior and deployment unexecuted.

## Initialization creation UI and request recovery source increment

Original capabilities now expose initialization_projects for current-owner
configured direct .git bindings with the existing native connection and explicit
initialization storage flavor. The fifth capability parameter defaults to false,
preserving existing callers. Initialization binding checks share the same pure
configuration predicate used by the kernel. JSON/YAML capability source objects
are paired, and the read-only variant excludes the new writable project list.

GitPanel reads the original initialization status before enabling the existing
repository snapshot. Missing metadata presents an initialization review entry.
The form requires an explicit initial branch and SHA-1/SHA-256 selection, displays
reviewed internal-ignore before/after hashes and byte size, and uses the original
prepare/read/approve/cancel receipts. Focus returns to the opener or workbench
heading after closing or completing the form.

GitIndexOperation now admits initialization through the original atomic endpoint
and keeps native dispatch as a separate explicit action. It checks original
review/acceptance/status branch, object format and ignore facts. Initialization
review changes return to the parent form. Existing scoped request persistence
accepts strict initialization prepare and approve/cancel commands, retaining the
original request/body/key for response-loss retry and reload reconciliation.
GitPendingRequests reopens the original current initialization review or accepted
operation. History and original recovery consume the same execution component.

After confirmed dispatch or recovery, the panel reloads initialization presence
and repository snapshot. A distinct binding-confirmation button is available for
applied and settled initialization records, including read-only history. It calls
the original settled dispatch fast path, which verifies the original outcome and
physical binding before refreshing. Response-loss reconciliation retains this
explicit confirmation path. Native writes still require original admission,
current authority, physical binding, custody and storage checks.

Existing metadata/reinitialization, linked/external bindings, local/remote branch
checkout, merged-safe deletion and reference backend coverage remain in full
M15.14 scope. This source increment followed the user's development-only direction.
Runtime UI rendering, tests, typechecks, builds, migrations and deployment remain
unexecuted.

## Existing repository initialization review source increment

The pinned upstream repositoryOperation init path runs Git init and then ensures
the project-internal ignore rules. The official Git initialization semantics keep
existing repository data during reinitialization. The current source increment
adds the original immutable review foundation for that existing-metadata path.
[Git init documentation](https://git-scm.com/docs/git-init)

freezeInitialization now distinguishes absent metadata from an existing bound
repository. Existing metadata uses the original normal repository snapshot and
sanitized read context. It verifies the requested object format against the
existing format and freezes the original HEAD, metadata digest, physical Git and
common-directory identities, .git file fact when present, common/worktree config
file facts and worktree-config enablement. Internal ignore before/after byte
facts use the existing upstream-adapted implementation. Source anchors, metadata,
directories, .git file and internal-ignore facts are repeated after private read
context disposal.

Protocol-2 initialization witnesses carry these existing-repository facts through
the same owner review/event records. Strict decoding validates exact shape,
format-sized HEAD OID and ref grammar, physical identities and bounded file facts.
Approval refreezes the exact original snapshot and compares the original witness
encoding. Existing protocol-1 preparation/review hash and serialized order remain
intact. The public optional reinitialization facts expose retained HEAD and config/
metadata digests. Paired request/review/facts schemas describe the snapshot source.
Original prepare/control route and operation descriptions cover both review modes.
Recovered reviews display the existing HEAD and configuration evidence.

The original existing-repository read context already handles operator-bound .git
files, Git/common directory relationships and worktree configuration. That same
context supplies reinitialization review facts for linked/common bindings. Full
native reinitialization remains to be connected, including same-volume generated
configuration, preserving original files and metadata, exact-owned publication,
original typed phases and interrupted recovery. Original admission, private plan
and execution-source readers explicitly enforce their current protocol-1 native
support until those phases exist. The creation UI keeps reinitialization at the
review stage during this increment. Damaged metadata and reference backend scope,
local/remote branch checkout and merged-safe deletion remain part of M15.14.

This increment is source development under the user's instruction. Source-object
comparison covered three paired schemas and two route/operation descriptions.
Runtime verification, tests, typechecks, builds, migrations and deployment remain
unexecuted.

## Reinitialization configuration preparation source increment

Original existing-repository review now derives configuration candidates using a
fixed Git init invocation inside its disposable read context. Only initialization
core/extension inputs enter the private active config. The empty template and
existing HEAD retain the reinitialization path. Existing common/worktree config
entries are read from independent original-byte copies with includes disabled.
The shared Git configuration renderer is reused by branch tracking and this path.

Private init supplies installed-Git format, bare, logging, shared-repository and
extension changes. The disposable-directory worktree setting is excluded from
publication candidates so the original bound worktree configuration is retained.
The active read config is restored before editing independent original-byte
copies. Candidates apply the selected initialization key changes and compare all
other parsed entries with the original, preserving duplicate and valueless data.
Raw output stays within the existing one-MiB configuration bound.

Filemode is sensitive to the target volume. Review freezes both false/true config
body hashes, the original common config hash and unchanged worktree config hash.
The native path will repeat preparation in its original same-volume allocation
and choose the candidate matching the actual probe. The disposable-context probe
result supplies neither publication authority nor an assumption about that volume.
Private HEAD/index/packed-ref/shallow/loose-ref/shared-index bodies are compared
before and after preparation. The active context and helper files are restored/
removed before original source snapshot/anchor checks continue.

Protocol-2 existing facts carry the optional configuration proof. Strict source
decoding links its original hashes and distinct candidate hashes. New approval
requires complete configuration proof and refreezes it. Older protocol-2 review
records retain read/cancel support and require a new review for approval. Public
review facts and recovery display the two candidate digests. Two paired JSON/YAML
schema source objects cover the configuration proof and original review facts.

Next work connects the same-volume original allocation, exact-owned preparation/
lock/publication and typed journal/native lifecycle for reinitialization, followed
by interrupted observation/cleanup and complete execution UI. Existing linked/
external and damaged metadata, local/remote checkout, merged-safe deletion and
reference backend coverage remain in M15.14. This increment is source development
under the user's instruction, with tests, typechecks, builds, native/product
operations, UI runtime acceptance, migrations and deployment unexecuted.

Installed-Git initialization behavior follows the
[official setup implementation](https://github.com/git/git/blob/master/setup.c).

## Reinitialization original directory layout source increment

Existing-repository review now freezes original root, Git and common-directory
physical identities, permission modes and UID/GID facts. It also records existing
or missing objects, objects/info, objects/pack, refs, refs/heads and refs/tags under
the actual configured common directory. The original directory reader retains
its canonical-path and symlink checks. Root/Git/common facts and child layout are
repeated around private configuration preparation and after read-context disposal.

Review source checks the canonical HEAD, index, config, packed-ref, root init and
internal-ignore locks. Existing locks report the original repository busy error.
The protocol-2 decoder checks exact layout shape, root/Git/common identity linkage,
mode/UID/GID types, fixed child paths, distinct child identities and missing-parent
consistency. New approval requires both full configuration and layout proof, while
older protocol-2 source retains read/cancel compatibility. The public review carries
only the layout digest and recovery UI displays it. JSON/YAML review-facts source
objects are paired.

This fixes the directory mode/group baseline needed before same-volume native
allocation, probing, required-directory additions and publication. Native
reinitialization allocation/locks, typed preparation/dispatch/outcome and original
native recovery/settlement remain the next work. Linked/external and damaged
metadata, checkout/deletion and reference backend coverage remain in M15.14.
This increment follows the user's source-development-only instruction. Tests,
typechecks, builds, native/product operations, UI runtime acceptance, migrations
and deployment remain unexecuted.

## Reinitialization owned allocation source increment

Configuration preparation now places original-byte copies, candidate files and
empty templates in one exclusive owned child allocation under its disposable Git
context. It reuses the existing protected .git.jot-init UUID pending namespace.
The allocator checks the original canonical parent identity, rejects symlink
ancestors, verifies matching device identity, and records exact namespace identity,
mode and UID/GID before child or process work. Preparation and cleanup callbacks
are synchronous original-service boundaries. The private read caller validates its
known context role; future native callers must persist the record in the original
typed journal under their held lease before work.

The operation receives a current-allocation guard. Configuration commands and
helper-file creation repeat it around asynchronous work. The ownership record is
strictly decoded and immutable during a live attempt. Parent and allocation cannot
share one physical identity. The planner accepts only the directory portion of its
internal context, so native preparation can supply a same-volume private metadata
context without manufacturing an unrelated read-context capability.

Cleanup runs once through the supplied atomic callback. It preflights the complete
owned tree, bounded to 512 entries, eight MiB total and one MiB per regular file.
Symlinks, special files and extra hardlinks remain unverified. Files are read through
no-follow descriptors into bounded buffers, with exact inode/mode/owner/size/link/
nanosecond and content checks. Every known remaining directory stays pinned through
removal. Cleanup removes known files and empty directories from this allocation;
canonical repository and ignore files stay outside its scope. Active private config
restoration remains before allocation cleanup. Cleanup failure preserves its cause.

The live caller is the original disposable reinitialization configuration planner.
Native same-volume source allocation, canonical locks/publication, typed journal
phases, actual probe selection and original recovery/settlement remain to connect.
Linked/external and damaged metadata, branch checkout/deletion and reference backend
coverage remain in full M15.14 scope. This increment followed the user's source-only
direction. Tests, typechecks, builds, native/product commands, UI runtime acceptance,
migrations and deployment remain unexecuted.

## Reinitialization original storage increment, 2026-11-09

The explicit offline reinitialization flavor retains the original execution table
and immutable preparation slots. Fresh initialization stays at protocol 7;
reinitialization reserves action init under protocol 8. The original ref-preparation
trigger retains its name and admits only commit/protocol 5 or init/protocol 8 in this
flavor. Its exact definition is part of schema recognition, so service construction
preserves the installed trigger and refuses an incomplete or changed new flavor.
Existing commit, branch and fresh-init capability/admission callers accept the
higher flavor while the original witness-2 execution gate remains in place.

The original offline maintenance connection exposes apply-reinit and rollback-reinit
with the existing physical database digest and explicit offline confirmation.
Migration retains original rows, rowids, foreign keys and all schema objects, with
only the original execution definition and this exact original trigger changing.
The original quiescence, physical identity and inventory guards remain in force.
Rollback to initialization requires no protocol-8 history, restores the exact old
trigger and preserves protocol-7 rows. Lower rollback fences remain. Older upgrade
entry points retain an installed higher flavor.

This source increment prepares durable ownership evidence for common-volume and
internal-ignore-volume allocations without introducing a second journal. Native
protocol-8 preparation/dispatch/outcome readers and writer, actual same-volume
probe selection, canonical locks/publication and original interrupted recovery,
drain and settlement still require connection. Linked/external and damaged
metadata, permissions/platform staging, branch checkout/deletion, reference backend
coverage and the remaining P09 features stay in scope. M15.14 remains in progress.
Per the user's development-only direction, no tests, typechecks, builds, native or
product operations, maintenance commands, migrations, UI runtime acceptance or
deployment were executed for this increment. Historical test results are retained.

## Reinitialization durable pre-dispatch recovery, 2026-11-09

Protocol-8 execution reads now require the original approved witness-2 source with
complete configuration/layout proof and exact source/repository/review hashes.
Fresh-init protocol-7 source pairing remains strict. The original journal decodes a
protocol-2 reinitialization plan and common-volume preparation, retaining the exact
owned allocation before child/process work. The original ref-preparation slot
decodes the second internal-ignore-volume allocation, exact first preparation,
selected approved configuration hash and empty common-volume config-lock facts.
The second allocation is needed when ignore changes. Both preparations retain the
original producer lease identity. Decoders reject wrong scopes, parents, aliases,
volumes, malformed facts and mismatched approved candidates.

Original row, producer and settlement readers recognize protocol 8. History stays
pending before preparation and unknown after preparation, and validates a second
record even before dispatch. Its contents join the original control-state hash.
Original resolution uses its existing reservation, sealed family, actual native
custody and fresh lease through native final checks/drain, then original settlement.
Pre-dispatch reinitialization cleanup validates physical binding and recorded
root/Git/common/internal identities and modes/owners, then removes only the recorded
internal-volume and common-volume namespaces through the original atomic authority
and bounded owned-allocation cleaner. Canonical repository files and locks are
outside this cleanup phase. No synthetic original producer finish is introduced.
Missing producer/first-preparation facts cannot legitimize a second record.

The original fresh-init file-fact validation is shared without changing its rules.
Witness-2 execution admission and the native initialization plan remain gated.
Protocol-8 dispatch/outcome publication is still unavailable, and an unexpected
protocol-8 dispatch is rejected. The next connection is the original one-use native
plan, common-volume private probe/configuration preparation and second-allocation
persistence, followed by typed dispatch, canonical locks/publication and observed
outcome recovery. Permissions/platform and linked/external/damaged cases, checkout,
safe deletion, reference backend coverage and all remaining P09 scope stay required.
M15.14 remains in progress. Per the user's development-only direction, no tests,
typechecks, builds, product/native operations, maintenance commands, migrations,
UI runtime acceptance or deployment were executed.

## Reinitialization retained native plan, 2026-11-09

The original prepareInitialization service/kernel entry point now handles witness 2
through a retained protocol-2 plan. It refreezes the complete reviewed source before
retention and requires complete configuration/layout proof. It captures original
root/program anchors and checks normal repository binding plus the full original
metadata digest before and after private ignore planning. Synchronous source checks
pin root/Git/common and required child directory identity/mode/UID/GID or absence,
the direct .git directory or exact pointer file, common/worktree configuration and
internal-ignore facts, and the original busy-lock exclusions. The projected ignore
bytes must match the approved hash/size/change flag. Final source and abort checks
precede storage in the kernel's existing private WeakMap. Serialized plans grant no
execution authority. Existing fresh-init preparation uses its original path.

The original applyInitialization signature accepts the typed plan union but rejects
protocol 2 before effects. Original witness-2 execution admission remains gated.
Actual common-volume allocation/probe and first/second preparation writer callbacks,
typed dispatch/outcome publication and post-dispatch recovery remain to connect.
This increment supplies the retained native preparation boundary only. M15.14 and
all other P09 requirements remain in progress. Per the user's development-only
direction, tests, typechecks, builds, product/native commands, maintenance/migrations,
UI runtime acceptance and deployment were not executed.

## Reinitialization same-volume private preparation, 2026-11-09

The original native execution branch now supplies protocol-2 preparation callbacks
to the retained reinitialization attempt. It validates one-use WeakMap custody,
source binding/full metadata, program/root/layout/configuration/ignore facts and
busy locks before allocating. The common-volume allocation persists its original
preparation under the held original producer lease before child or process work.
Its minimal private Git metadata retains source HEAD bytes, SHA1/SHA256 base format
and tracked physical directory identities. Existing config preparation repeats
inside this same-volume context under original authorize/atomic-cleanup callbacks.
Its actual observed filemode selects an approved full candidate, and both review
candidate proofs must still match. The selected pending config is synced with the
original file mode (or normal umask for a new config), plus a private empty lock.

If ignore changes, a second allocation is made on the internal-ignore parent volume.
Its original ref-preparation transaction records exact first preparation, chosen
configuration/empty-lock facts and second namespace before ignore/lock creation.
Both records retain original producer lease identity. The allocator exposes its
already-validated live ownership record to its synchronous authorize callback,
allowing only its own newly created namespace to be excluded before the preparation
callback. Original source metadata guards skip these known roots, and a full
original metadata read before/after the private probe uses the same exclusions.
Existing readers use empty exclusions and keep their prior encoding. Private
context directory identities are checked around asynchronous work. Nested helper
and outer cleanup use original atomic authority and bounded exact-owned removal.

This increment connects actual private preparation and original preparation writers.
It still stops at the pre-publication boundary with reinitialization unavailable.
Original admission remains gated. Typed protocol-8 dispatch/outcome, canonical
locks/configuration/ignore/required-directory publication and post-dispatch recovery
remain to implement before enabling effects. Permissions/platform and linked,
external/damaged cases, branch checkout/deletion, reference backend coverage and all
remaining P09 features remain required. M15.14 stays in progress. Source-only work
followed the user's instruction. No tests, typechecks, builds, product/native
operations, maintenance commands, migrations, UI runtime acceptance or deployment
were executed.

## Reinitialization dispatch evidence and owned cleanup, 2026-11-09

Original protocol-8 dispatch now binds the first preparation and optional exact
second ref-preparation, selected approved configuration candidate, pending config
and empty config-lock identities, and changed ignore/empty-ignore-lock facts.
Strict decoding checks shapes, candidate and ignore hashes/sizes, matching nested
records, distinct identities and each file's own allocation volume. Unchanged
ignore requires no second record or ignore file/lock. Original dispatch insertion
validates both original records under the same producer lease before any canonical
lock or file publication. Private files are re-read before dispatch. The original
reader requires the exact original preparation/ref-preparation and producer lease,
so history/control state and original producer finish distinguish dispatched work.

Original native control now connects post-dispatch exact-owned cleanup. It verifies
physical repository binding and root/Git/common/internal identities, preflights all
canonical empty-lock identities/content/modes/link counts, and removes only those
proven locks. It then invokes the existing bounded owned-namespace cleaner inside
original atomic authority. Missing already-cleaned namespaces are idempotent. A
foreign lock, link, namespace or directory change remains unverified. Canonical
repository/ignore files and directories are preserved. Cleanup does not establish
an applied result or replay publication. The original fresh recovery lease/native
family/drain and settlement authority remains responsible for closure.

Fresh-init outcome publication explicitly narrows protocol 1. Repository cache
adoption remains specific to protocol-7 fresh initialization, since reinitialization
keeps its normal existing repository binding. The current protocol-8 private
attempt still stops before canonical publication. Outcome decoding deliberately
requires the existing fresh-init proof until the reinitialization publisher and
observer supply their own evidence. Original reinitialization admission remains
gated. Required directory/permission projection, canonical config/ignore locking
and publication, protocol-8 observed outcomes and complete UI/native execution
remain to connect. Linked/external/damaged and platform cases, branch checkout/
deletion, reference backend coverage and all remaining P09 scope remain required.
M15.14 stays in progress. Per the user's source-only direction, no tests,
typechecks, builds, product/native commands, maintenance commands, migrations,
UI runtime acceptance or deployment were executed.

## Reinitialization native directory-mode projection, 2026-11-09

The same-volume private config preparation now accepts the original frozen layout.
Within the existing owned outer allocation it seeds common/root and six fixed
metadata directories with original existing modes. Missing private directories use
normal creation mode and umask. The minimal objects/refs context directories use
normal directory creation inside the protected outer namespace, preserving the
missing-directory probe instead of introducing a private 0700 result. The fixed
private Git init then supplies its actual resulting common/objects/refs modes.
Directory physical identities are checked before and after asynchronous reads and
mode seeding, around Git init and on repeated final projection reads.

Only the native caller supplies this layout. The disposable review caller keeps
its previous directory setup and returned review hash encoding. Native private
Git metadata remains enclosed by its original exclusive owned allocation. The
actual seven-path mode projection enters original typed dispatch as optional
directory_modes. The decoder requires exact fixed path order and integer modes
from zero through 07777. Older records without projection remain readable for
observation/cleanup. Mode facts supply no filesystem authority.

This increment supplies directory permission evidence needed before canonical
publication. UID/GID inheritance and existing owner handling still require actual
publisher/observer checks, including linked/external/damaged and platform cases.
Canonical config/ignore locks and publication, directory effects, private receipt,
protocol-8 outcome observation and native/UI admission remain to connect. Branch
checkout/deletion, reference backend coverage and all other P09 scope remain
required. M15.14 stays in progress. Per the user's development-only instruction,
no tests, typechecks, builds, product/native commands, maintenance commands,
migrations, UI runtime acceptance or deployment were executed.

## Reinitialization observed outcome proof, 2026-11-09

Original dispatch now optionally retains immutable_metadata_sha256. Before private
allocation the original native attempt takes an immutable source digest between
matching complete approved-source anchor reads, then requires the same digest at
dispatch. It includes the object store, HEAD, refs, index and other preserved
metadata. Only the operator-bound mutable config/ignore and exact empty-lock paths,
recorded owned namespaces, and separately proven writable directory facts are
excluded. The existing sourceMetadata default keeps its prior object exclusion for
older index/commit callers; reinitialization explicitly includes objects. Existing
records without this new fact remain readable for cleanup.

Strict protocol-2 private receipt decoding binds complete mode projection and
immutable digest to the original dispatch. It checks all seven directory paths,
projected modes, retained existing identities/UID/GID, distinct new identities and
new directory UID ownership, plus original/internal directory identity and complete
physical facts. Full new-group/platform inheritance remains for the actual writer.
The original read-only observer checks bound root/Git/common and pointer facts,
retained root/Git permissions and owners outside the mutable common directory,
canonical config/worktree/ignore file facts, complete immutable metadata and repeat
physical directory snapshots. Only the complete matching state supplies the strict
receipt. Missing evidence or partial/changed effects remain unknown.

Original native control can record that observed applied receipt and public result
in the existing immutable outcome wrapper, then perform exact-owned cleanup. It
retains original fresh lease, native family/drain and settlement authority, and
never fabricates an original producer finish. Original outcome readers select the
correct protocol-specific private receipt. Fresh-init proof encoding is retained.
Canonical lock installation and actual config/ignore/directory publication remain
to connect, with new UID/GID inheritance and linked/external/damaged/platform cases.
Admission remains gated. Complete UI/native flow, branch checkout/deletion,
reference backend coverage and all remaining P09 scope remain required. M15.14
stays in progress. Per the user's source-only direction, no tests, typechecks,
builds, product/native operations, maintenance commands, migrations, UI runtime
acceptance or deployment were executed.

## Reinitialization canonical publication kernel, 2026-11-09

Original native reinitialization now supplies its synchronous publication callback
to the original outcome transaction. The retained producer prepares and dispatches
first. A one-use live publication closure then installs exact private empty config
and ignore lock inodes by exclusive hardlink, validates aliases, applies the actual
same-volume directory mode projection, and atomically renames each synced pending
config/ignore file on its own volume. Existing directories retain identity/UID/GID;
new metadata directories check allocation UID and native effective/parent-setgid
group inheritance. Project-internal creation uses its own allocation UID. Every
phase repeats current physical/program/root/pointer, directory/owner/mode, source
metadata, worktree/config/ignore and exact empty-lock facts. The normal existing
repository binding is retained.

The live closure creates its strict private receipt from actual published facts.
The original transaction validates original dispatch, records public/private
outcome, and checks a single returned receipt. Late/repeated closure calls and
asynchronous authority are rejected. Original phase-aware checks continue through
outer allocation cleanup after successful publication. Live and interrupted
cleanup share the same exact empty-lock preflight/removal. Live cleanup uses the
original one-shot atomic boundary and preserves the publication failure cause.
Temporary namespaces are then removed by the existing bounded owned cleaner.
Canonical partial effects remain for original read-only observation and explicit
control, with no rollback or replay. The observer additionally repeats original
normal anchors and final receipt facts around its metadata read.

This connects the canonical writer and original direct outcome path in source.
Original protocol-8 admission remains gated while permission inheritance edge
cases, config/ignore ownership semantics and complete linked/external/damaged/
platform behavior and UI admission are completed. Branch checkout/deletion,
reference backend coverage and all other P09 features remain required. M15.14
stays in progress. Per the user's development-only direction, no tests,
typechecks, builds, product/native operations, maintenance commands, migrations,
UI runtime acceptance or deployment were executed.

## Reinitialization file groups and complete mode facts, 2026-11-09

Original initialization source/kernel file facts and strict readers now retain
mode bits through 07777, matching Git's complete-mode copy in its config rewrite
source. Existing lower-mode records remain readable. Fresh/reinitialization source
comparisons use complete current bits. The original pending-file descriptor helper
can set a target group on its own newly created file before final chmod/fsync,
validating numeric conversion, descriptor identity, unchanged UID and resulting
GID. The existing original fresh-init callers omit this option.

Native reinitialization chooses config GID from the projected final common setgid
mode and original common group, or the actual common allocation's inherited group.
It sets that group before the original second preparation. Changed ignore retains
the original file's group when it exists, and otherwise uses the actual internal
allocation group. Source facts are checked around that existing-ignore ownership
read. Optional typed dispatch file_groups strictly binds config/ignore group
strings and the projected config-parent rule. Pending files, live canonical phases
and original publication/observation snapshots check the recorded groups. Older
dispatch without group proof remains readable under its existing semantics.

A different-owned existing ignore is currently rejected before canonical effects,
so that this atomic replacement path cannot silently change its UID. Full support
for that original in-place-write ownership case remains required, alongside
special filesystem/group/platform inheritance and full native/UI admission.
Original protocol-8 admission remains gated. No foreign UID is assigned to a
private namespace that its existing bounded ownership cleaner cannot safely reclaim.
M15.14 and all other P09 scope remain in progress. Per the user's source-only
direction, no tests, typechecks, builds, product/native operations, maintenance
commands, migrations, UI runtime acceptance or deployment were executed.

Primary source behavior was read from Git config.c and setup.c. This implementation
uses original project helpers and fixed commands.
[Git config.c](https://github.com/git/git/blob/master/config.c), [Git setup.c](https://github.com/git/git/blob/master/setup.c)

## Reinitialization existing-ignore inode ownership, 2026-11-09

Changed existing internal ignore now uses an original append-only publication
strategy. Original native preparation captures exact current UID/GID around the
approved before-file proof and records optional ignore_in_place owner facts in
original typed dispatch. Its private candidate stays 0600 under the allocator's
own UID/GID, so foreign-owner source data never becomes a foreign-owned scratch
file that cleanup cannot reclaim. The previous different-UID rejection is removed.
Strict evidence requires a changed existing ignore and a matching recorded group.
Newly absent ignore keeps its existing same-volume replacement path. Old dispatch
without this strategy retains its original replacement interpretation.

The live original publication transaction validates the complete private candidate
and exact approved original prefix. It opens only the existing canonical file with
no-follow/nonblocking append access, without create or truncate. Bounded suffix
writes repeat native authorization, descriptor/path inode, regular-file/link count,
size and UID/GID checks. Append mode preserves concurrently appended bytes and an
unexpected size makes the result unknown. It syncs, checks original mode and exact
approved final file facts, and closes the descriptor on every exit. A partial
append keeps the existing prefix and never rolls back or replays its suffix.

Canonical target-fact derivation now retains the original inode/mode while binding
the approved final hash/size. Live phase checks and the original repeated observer
validate this target plus UID/GID. Exact-owned empty locks and private allocations
still use original cleanup and native drain/settlement. A complete observed result
can produce the original receipt, and partial/changed content remains unknown.
Original fresh-init proof/observer logic is retained. Special-mode restoration and
unusual filesystem/group/platform cases remain to complete, as do native/UI
admission, linked/external/damaged coverage, branch checkout/deletion, reference
backend coverage and all other P09 requirements. M15.14 stays in progress and
original protocol-8 admission remains gated. Per the user's source-only direction,
no tests, typechecks, builds, product/native operations, maintenance commands,
migrations, UI runtime acceptance or deployment were executed.

## Reinitialization admission and original UI flow, 2026-11-09

Original initialization admission now selects protocol 8 only for a complete
approved witness 2 and explicitly installed reinitialization schema. Witness 1
keeps protocol 7. Older schema still returns the original upgrade-required result.
Original current-owner/review/version/binding/idempotency/pending exclusion and
native reservation/custody/lease/producer/drain/settlement paths stay in place.
There is no new execution table, host or authority channel.

The original capability adds optional reinitialization_projects only with native
configuration and explicit reinitialization storage. It uses current-owned bound
projects and preserves the default-false sixth service parameter. Fresh-init
initialization_projects keeps its original direct .git requirement. The paired
JSON/YAML capability source objects match, and other OpenAPI objects are retained.
No maintenance command or migration was executed.

GitPanel now exposes an existing-repository review using its actual normal snapshot.
It seeds the branch request from current HEAD when available, and object format
from the supported current HEAD OID length when available. Unknown values stay
explicit form choices. Review labels make the retained HEAD clear. Original review
prepare/approve/cancel and draft-key handling are reused. Native admission and
actual dispatch remain separate explicit actions. Pending requests and history
propagate separate fresh-init/reinitialization capabilities. GitIndexOperation
selects the capability from the re-read original review facts, and preserves its
existing no-automatic-init-dispatch rule. Applied/settled reinitialization refresh
uses the original completed fast path and retains normal repository binding.
Focus restoration and original unknown/control behavior are reused.

This opens the completed source chain under explicit protocol-8 storage capability.
Special-mode/filesystem/group/platform and linked/external/damaged cases still need
completion through their actual call paths, as do local/remote branch checkout,
merged-safe deletion, reference backend coverage and all other P09 requirements.
M15.14 stays in progress. Per the user's source-only direction, no tests, typechecks,
builds, product/native operations, UI rendering/runtime acceptance, maintenance
commands, migrations or deployment were executed.

## Existing branch checkout target commits, 2026-11-09

Original branch inventory now resolves local and remote branch object IDs to their
commit targets with one bounded private cat-file batch-check. Inputs are validated
full object IDs plus the fixed commit-peeling suffix. It reuses the original
sanitized read context, object-store binding, output/time/cancellation limits and
context disposal. Exact output row count, termination, object format and commit
type are validated. A direct commit must retain its original object ID. A noncommit
object that cannot peel to a commit is recorded as null. No per-branch child process
or caller-provided command is introduced. Original snapshot and full source
metadata are checked again after target resolution.

The shared inventory contract adds optional nullable checkout_oid. Paired JSON/YAML
source objects match and all other OpenAPI objects are retained. Existing raw ref,
OID, object type, symbolic target, ordering and current-branch facts stay present.
The original branch list shows a distinct peeled commit where needed and an
unresolvable target state. Older payloads omitting checkout_oid retain their prior
display. This supplies the target proof required by existing-branch checkout.

Actual checkout review, worktree/index/dirty-content projection, local/remote
tracking and detached behavior, native publication, original recovery and UI
execution remain to connect. Checked-out worktree exclusions, conflicts, unborn
semantics, safe deletion, reference backend and full initialization/platform scope
remain required in M15.14. All remaining P09 scope is retained. Per the user's
source-only direction, no tests, typechecks, builds, product/native operations,
UI runtime acceptance, maintenance, migrations or deployment were executed.

Batch output behavior was read from the [Git cat-file documentation](https://git-scm.com/docs/git-cat-file).

## Registered worktree branch-use facts, 2026-11-09

The original branch inventory now reads registered common and linked worktree
metadata and attaches optional worktree_uses facts to local branches. Facts name
only current/other and HEAD/rebase/bisect/update_refs. Other checkout paths and
registration identifiers stay private. The original UI displays each reason.
HEAD resolution follows bounded symbolic references, including worktree-scoped
refs. Detached rebase and bisect branches and rebase update-ref records are read
from their original metadata. Missing/empty linked registration files are skipped.
A linked current worktree is identified by physical directory identity. Main
worktree bare configuration is read with fixed no-includes config arguments.

Metadata file reads retain original no-follow, single-link, bounded descriptor
checks. The new reads have an aggregate 8 MiB bound, worktree/reference counts
are limited, operation-state directories are physically checked, and the original
snapshot and full source metadata are checked again before inventory returns.
Malformed operation records fail the read instead of yielding an empty use list.
The optional contract field keeps prior payloads readable. Existing branch facts
and execution_authorized=false remain in the original contract.

This is inventory source development. Checkout review must bind these facts to
its own fresh witness and recheck them through native publication. Checkout's
complete worktree/index/dirty-content projection, tracking/detached behavior,
writer, recovery and UI dispatch remain open. Safe deletion, reference backend,
initialization platform scope and all remaining P09 features are retained.
No tests, typechecks, builds, native product operations, UI runtime acceptance,
maintenance, migrations or deployment were performed.

Occupancy semantics were read from the official Git sources for
[branch ownership](https://raw.githubusercontent.com/git/git/master/branch.c),
[worktree registration](https://raw.githubusercontent.com/git/git/master/worktree.c),
[operation state](https://raw.githubusercontent.com/git/git/master/wt-status.c) and
[update-ref records](https://raw.githubusercontent.com/git/git/master/sequencer.c).

## Branch checkout index preview, 2026-11-09

The existing owner/snapshot-scoped branch GET accepts an optional target_ref.
It resolves that exact listed local/remote reference to the already proven commit
and returns an optional checkout_preview. The default branch inventory retains
its previous response shape. The service repeats ownership and cancellation checks.

The preview copies the original private index again, preserves its conservative
mtime and refreshes that planning index with fixed Git arguments. GIT_INDEX_FILE
is an internal transport parameter. Its only new caller supplies a fixed private
path. Existing transport callers keep their previous environment. A two-tree
read-tree dry-run checks the actual bound worktree, including staged, unstaged
and untracked state. Recursive submodule updates are explicitly disabled.
A failed check returns not_confirmed and a null projection. Successful checks
produce a separate private index through --index-output, with a bounded digest,
entry count and exact before/after object/mode changes. The existing entry parser
is shared with commit-tree inspection. An unborn HEAD uses a verified empty tree
written only into the private object store. Private object writes read original
objects through the existing alternate binding. Original snapshot/full metadata
checks, process limits, cancellation and context cleanup finish the read.

The common read-copy now obtains info/sparse-checkout from the current worktree,
matching Git's worktree-specific path rules. Private index/shared-index mtimes
use an earlier whole second so fractional timestamp rounding cannot move a copy
past the original racy-clean boundary. Index contents retain their original hash.

The branch list opens an owner/snapshot/target-scoped preview, shows fresh target
ownership reasons and index changes, cancels reads on close and restores the
invoking button's focus. Paired JSON/YAML branch contracts include the optional
query and result. The operations manifest updates its existing description.

This delivers preview source. Complete worktree content/attribute publication,
tracking/detached policy, reference/reflog evidence, original immutable review,
approval, native execution/recovery and UI dispatch remain required. All M15.14
and remaining P09 scope stays open. Work was limited to source development,
source-object comparison and Git delivery. Historical test results stay historical.

Primary behavior is documented by [Git read-tree](https://git-scm.com/docs/git-read-tree),
[Git update-index](https://git-scm.com/docs/git-update-index),
[checkout setup](https://raw.githubusercontent.com/git/git/master/builtin/checkout.c)
and [worktree-specific paths](https://raw.githubusercontent.com/git/git/master/path.c).

## Checkout raw content and target-index attributes, 2026-11-09

The existing checkout preview now reads distinct blob IDs from both sides of
its exact index changes. A single fixed batch-check validates each expected ID,
blob type and canonical safe size before any body read. When all distinct bodies
fit the existing 32 MiB per-object and 64 MiB total content budget, one bounded
batch read reuses the original object parser to verify framing, type, algorithm,
object identity and exact size, then attaches SHA-256 facts. Beyond that budget,
all index changes retain their known blob sizes and explicit null digests. Gitlink
entries retain their commit IDs. Original object bodies stay outside the response.

A fixed cached check-attr command uses the projected private index and NUL input
paths. Exact NUL triples, requested paths, unique names, counts and output limits
are checked before sorted target-index attributes are returned. Original context,
source-owner, snapshot/metadata and cancellation/cleanup guards remain. The
paired contract adds optional blob and attribute facts, preserving older payloads.

The original preview UI shows raw blob sizes/digests and target-index attributes.
Index changes and attributes each render in 50-row pages, with all rows reachable
and independent page controls. Retry resets the pages. Original scope checks,
loading, cancellation and focus behavior are retained.

Raw content and attribute evidence now feed the source preview. Bounded final
worktree conversion, sparse/symlink/gitlink/directory effects, physical file
before-states, complete original immutable review and approval, reference/log/
tracking policy, native publication/recovery/UI and safe deletion remain required.
M15.14 and all remaining P09 scope stay in progress. Work was source development,
source-object comparison and Git delivery only. Historical test results remain
historical.

The batch protocol is documented in [Git cat-file](https://git-scm.com/docs/git-cat-file).
Cached attribute selection and NUL triples follow [Git check-attr](https://git-scm.com/docs/git-check-attr).
