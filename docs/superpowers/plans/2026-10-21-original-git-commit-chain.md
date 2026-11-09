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
