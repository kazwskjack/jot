# Original reviewed Git commit chain

> Execute through the existing single-agent plan workflow. Preserve the full26
> capability ledger and original branch/destructive/revert/remote requirements.

**Goal:** connect an exact reviewed staged tree to an original local commit,
including immutable admission, real native effects, explicit recovery and UI.

**Architecture:** keep DSH planning/Session/Goal, original Gateway identities,
physical database, project/family reservation and Worker custody. Extend the
owning operation lifecycle; introduce no second registry, queue, scheduler or
permission authority. Do not reinterpret the index-only receipt as a commit.

**Reference:** the pinned PilotDeck `src/session/checkpoints/repositoryOperation.ts`
compares `write-tree` with an expected index tree, then invokes Git commit inside
the existing repository-operation coordination. Reuse that expected-tree behavior
conceptually. Do not copy AGPL source into the Apache-2.0 implementation or import
its direct source-directory Git subprocess path as a replacement for original
owner/native custody, hooks/config isolation or unknown-effect recovery.

## Source findings and full requirements

- Existing `GitMutationIntents` accepts commit review and requires all visible
staged paths. Its current protocol2 witness freezes worktree file bytes and the
raw index hash; it contains no independently verified staged-tree/object proof.
The execution source and index journal deliberately accept stage/unstage only.
- The original index effects receipt proves an index replacement, not branch
publication or commit identity. Its SQL CHECK, evidence decoder, reservation,
producer and native protocol cannot be widened by merely changing capability UI.
- Commit metadata must freeze exact message, author/committer and operator
configuration, target ref/unborn/detached state, parent, tree and current original
review/version before effect rights exist. No inherited signing program, hooks,
filters, external diff, credential prompt, network fetch or config include.
- The existing stable physical repository namespace must exclude index, file
publication, Agent/Work/shared writers and checkpoint restore throughout commit.
A new action discriminator must preserve old immutable receipts and original
unknown producers, including offline migration/rollback and old-consumer fences.

## Task1: Exact staged-tree evidence in the existing review flow

Files: `packages/gateway/src/git/{inspection,service,intents}.ts`,
`packages/gateway/test/git/commit-review.test.mjs`.

- [x] Write a failing real-repository review test with staged bytes different
from worktree bytes. Require exact tree OID, staged entry manifest and verified
object digests, no changed source index/refs/object files and no execution grant.
- [x] Compute the tree only in the existing private controlled metadata copy,
with a private object output directory and source objects read as alternates.
Validate full stage0 inventory, object format, raw blob content hashes and the
resulting recursive tree; do not trust an index cache-tree extension alone.
- [x] Bind evidence to the existing snapshot/index/HEAD/root and final source
metadata check. Persist it in the original review witness; approval recomputes
it. Original stage/unstage witness shape and receipts stay unchanged.
- [x] Verify SHA1/SHA256, unborn HEAD, corrupted/missing/wrong-type blobs, stale
index, hidden selection, owner revocation and cancellation. Legacy commit review
without the new proof needs a fresh review, not silently upgraded authority.

## Task2: Original commit intent and immutable acceptance

- [x] Freeze exact operator author/committer policy, complete message bytes,
parent/unborn/detached target, object format, staged-tree evidence and original
review/version. Project configuration is a reference, never browser command/env.
- [x] Add commit as its own typed effect to the original owning operation
lifecycle and SAME physical DB/reservation/Worker namespace. Audit every immutable
journal decoder, schema hash, old consumer and coordinator before migration;
retain old stage/unstage and file-publication receipts byte-for-byte.
- [x] Separate atomic acceptance from native physical effects. Cached responses
check current owner and never reauthorize a cancelled review. Complete strict
shared contracts, original BFF, status/history and unchanged default capabilities.

## Task3: Actual native commit and interrupted outcome

- [x] Prepare exact tree/commit objects in private output without loading source
hooks/signing/includes. Retain original root/ref/index/object and native-family
custody; acquire/journal canonical lock ownership before original physical writes.
- [x] Publish only the reviewed object graph and compare-and-swap the exact
original ref or detached HEAD under original synchronous approval/lease fences.
Record expected old/new OID and append-only per-effect facts BEFORE publication.
Do not run raw `git commit` against untrusted source config.
- [x] Normal completion settles only after original producer/native drain.
After process exit, lost response, changed root/ref/index, lease takeover or
revoked owner, reconcile recorded object/ref facts with fresh original custody.
Never auto-create another commit, roll back external effects, claim an unknown
ref update failed, delete another writer's locks or treat expired lease as drain.

## Task4: Original mobile commit UI and complete acceptance

- [x] Show exact reviewed staged tree, complete staged selection, parent/target,
message and configured author policy; explicit review/approval then original
admission/dispatch. Reuse original same-key remount recovery and history.
- [x] Connect actual React/BFF/Gateway and original separate-SDK Host source
entry points for commit, reload/history recovery, exact staged tree/parent/message,
SHA256, unborn/detached state, explicit cancellation and unknown-result disposition.
- [x] Deliver the scoped source changes through the existing development branch
and non-force Git push. P09 continues branch/worktree/destructive/revert/remote work.

## Development-only execution update

The user removed future testing and acceptance work from the implementation plan.
The completed Task1 historical verification records above remain historical. Tasks
2–4 are tracked as source-development completion. This increment did not run tests,
typechecks, builds, SDK/native commands, migrations, UI acceptance or deployment.
The full absorption objective continues through the remaining implementation batches.

## P09 branch inventory groundwork

M15.14 is in progress. The original owner-bound Git reader now exposes a
snapshot-bound local/remote branch inventory through Gateway, the private BFF,
shared contracts and the existing workbench. Each entry retains its full ref,
remote prefix, exact object identity and symbolic target. The reader uses the
existing isolated config/object context, cancellation and bounded output, then
rechecks the original repository snapshot before returning. The workbench reads
this inventory on demand and refreshes the repository after stale-snapshot errors.

The existing loose/packed-reference reader now rejects non-files ref storage
before creating a misleading snapshot. Reftable support remains outstanding.
Reference syntax is shared with original commit review/evidence consumers while
retaining their target restrictions and frozen metadata encoding.

Repository initialization and branch create/checkout/delete remain required.
They must use reviewed original operation identities, native workspace custody,
conflict handling and interrupted-effect recovery. This increment adds the read
prerequisite only. P09 also retains discard/delete, revert, remote fetch/pull,
push/publish and original staged/file recovery scope. The upstream 5000-path and
20000-character commit input capacities remain to be reconciled with Jot's
current 100-path and 4096-character review limits.

## P09 staged-operation input capacity

The original stage/unstage/commit review now accepts up to 5000 selected paths.
Commit messages accept up to 20000 JavaScript UTF-16 code units, matching the
pinned upstream operation input bound. This expansion reaches original review
normalization and freezing, persisted commit review readers, host-private commit
preparation, index/commit evidence readers, browser recovery drafts and controls.
The Git contracts include nested execution, inspection, resolution and history
results. Message byte metadata allows up to 60000 UTF-8 bytes, the maximum for
20000 valid UTF-16 code units. Existing exact message hashing/body derivation,
identity policy, source/native custody and original receipt encodings remain in
use. Existing smaller persisted requests retain their original bytes and keys.

File path length, total content/object/output bounds, timeouts and publication
input limits continue to be enforced by their original consumers. M15.19 remains
in progress until all original staged/file interruption recovery implementation
is covered. This capacity increment is source development only.

## P09 original index root and reference recovery boundaries

Source tracing of original completeControl/reconcile callers identified an
observation gap after asynchronous blob reads. observeEvidence now rechecks
repository binding, retained physical root identities, the original .git witness,
HEAD/packed/branch references and the exact published index inode/hash after all
object reads and private-context disposal. A replaced root or changed reference
retains an unknown/error observation through the original coordinator.

Original applyIndex failure cleanup now checks retained roots and .git identity
before each exact-owned lock or created-parent deletion. A moved/replaced root
cannot acquire cleanup authority by containing a previously owned inode. This
reuses the root guard already required by original source publication checks.
Original lease/owner transactions, native drain, journal evidence and result
encodings continue to be consumed by the existing recovery entry points.
This increment is source development only. Remaining original stage/file boundary
coverage is tracked in M15.19.

## P09 original create-branch review ledger

The create-branch review API is mounted in the actual Gateway and original
private BFF path. It freezes current HEAD/object format, unborn or detached state,
index identity, original repository metadata and the exact new local reference.
It rejects existing references, directory/file prefix collisions and normalized
case aliases, and uses the fixed isolated check-ref-format command for Git's
branch-name rules. Source configuration cannot supply executable behavior.

Create/read/approve/cancel use the existing wb_git_mutation_intents and
wb_git_mutation_events tables, original atomic HTTP receipt protocol, owner
checks, review hash and version transitions. Approval captures the same original
source again. Original file-review readers exclude the new branch review kind.
The branch service creates no additional review or execution tables.

This increment delivers backend review and shared contracts. Actual creation,
HEAD/reflog publication, native workspace custody and interrupted recovery remain
required before execution is exposed. UI entry/recovery, initialization and
existing-branch checkout/deletion also remain in M15.14. This source increment
has not run product commands, tests, typechecks, builds or UI acceptance.

## P09 original branch execution schema preparation

Branch protocol 6 extends the original execution table through the existing
offline maintenance transaction, preserving original rows/rowids, receipts,
application inventories, triggers, views, indexes and foreign-key integrity.
Creation is the first branch action represented by this schema. Existing
commit readers/capabilities accept the branch schema while retaining protocol-5
commit semantics. Existing constructors keep the installed table constraints.

The original CLI now routes apply-branch and rollback-branch through the same
physical database identity and explicit offline-confirmation boundary. Downgrade
to the commit schema requires absence of branch/protocol-6 rows, including
historical records. Existing apply-commit preserves an installed branch schema.

This is partial M15.14 source development. Actual branch admission, native
creation, HEAD/ref/reflog effects, recovery and UI remain required. Commands,
migrations, tests, builds and runtime acceptance have not been executed.

## P09 original branch admission and pending history

Approved create-branch reviews now enter original protocol-6 execution and
admission tables. Their typed receipts/status/history retain new branch ref/OID
and original HEAD, exact original request/review/witness identity and configured
binding. The original never-started confirmed control closes only records with
no reservation, producer or effects. Existing pending-work exclusion applies.

The workbench history reads and checks branch facts. Physical branch dispatch,
host execution and generic index recovery remain guarded until typed branch
native phases are implemented. Shared immutable review source readers preserve
the original reviewed request/hash bytes. Branch admission requires explicit
branch storage. This remains partial M15.14 development. Reflog actor/time/policy
freezing, native custody, HEAD/ref/reflog effects and interruption recovery,
creation UI, initialization and existing-branch operations remain required.
No tests, builds, migrations or native/product commands were executed.

## P09 frozen branch reflog actor and policy

Create-branch witness protocol 2 freezes effective common/worktree log policy
and original HEAD/branch log hashes and sizes. Configured operator committer
identity, one UTC whole-second time, exact log-policy digest and append decisions
join the original review hash. Approval/admission recheck configured identity
at the captured time. Historical protocol-1 review/admission reads and explicit
cancellation retain their original request/hash/receipt encoding.

The shared contracts and read-only history include optional frozen metadata.
Boolean configuration and worktree enablement use Git's original canonical
parser. Valueless reference-storage extensions are rejected by the existing
unsupported-backend guard. Fixed isolated branch-name rejection returns the
invalid-branch error. Native branch creation, exact-owned HEAD/ref/reflog phase
publication and interrupted recovery remain in M15.14. This is source development
only, with no test/build/native/maintenance/migration/runtime execution.

## P09 private automatic tracking config derivation

The original branch review calls a fixed private configuration planner. It
retains duplicate/valueless common and worktree tracking data, verifies the
original commit object, derives Git's new-branch remote/merge/rebase settings,
and verifies the private ref's exact expected OID. The original common config
copy receives only those generated key changes. Other active private entries
are checked before/after, and source/raw configuration stays behind the original
read boundary. Frozen before/after config hashes and a config review digest join
the original review and history. Earlier witness/metadata records remain
readable/cancellable and require a fresh full review for new approval/admission.

The private planner is connected to the actual review entry point. Native source
publication, exact-owned config/HEAD/ref/reflog phases and interruption recovery
remain required. This increment did not execute tests, builds, SDK/native/product
or maintenance commands, migrations or UI acceptance.

Private simulation restores its original active config and removes its generated
private ref/worktree config before the original source snapshot is read again.
The surrounding original context disposal owns all remaining private scratch.

## P09 create-branch original native phases

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

## P09 create-branch UI and capability

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

## P09 uninitialized repository review

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

## P09 initialization admission and never-started control

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
