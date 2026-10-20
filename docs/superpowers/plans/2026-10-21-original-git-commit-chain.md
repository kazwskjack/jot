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

- [ ] Freeze exact operator author/committer policy, complete message bytes,
parent/unborn/detached target, object format, staged-tree evidence and original
review/version. Project configuration is a reference, never browser command/env.
- [ ] Add commit as its own typed effect to the original owning operation
lifecycle and SAME physical DB/reservation/Worker namespace. Audit every immutable
journal decoder, schema hash, old consumer and coordinator before migration;
retain old stage/unstage and file-publication receipts byte-for-byte.
- [ ] Separate atomic acceptance from native physical effects. Cached responses
check current owner and never reauthorize a cancelled review. Complete strict
shared contracts, original BFF, status/history and unchanged default capabilities.

## Task3: Actual native commit and interrupted outcome

- [ ] Prepare exact tree/commit objects in private output without loading source
hooks/signing/includes. Retain original root/ref/index/object and native-family
custody; acquire/journal canonical lock ownership before original physical writes.
- [ ] Publish only the reviewed object graph and compare-and-swap the exact
original ref or detached HEAD under original synchronous approval/lease fences.
Record expected old/new OID and append-only per-effect facts BEFORE publication.
Do not run raw `git commit` against untrusted source config.
- [ ] Normal completion settles only after original producer/native drain.
After process exit, lost response, changed root/ref/index, lease takeover or
revoked owner, reconcile recorded object/ref facts with fresh original custody.
Never auto-create another commit, roll back external effects, claim an unknown
ref update failed, delete another writer's locks or treat expired lease as drain.

## Task4: Original mobile commit UI and complete acceptance

- [ ] Show exact reviewed staged tree, complete staged selection, parent/target,
message and configured author policy; explicit review/approval then original
admission/dispatch. Reuse original same-key remount recovery and history.
- [ ] Verify actual React/BFF/Gateway/separate-SDK process commit, reload without
recommit, index/working bytes unchanged, exact parent/tree/message, unborn and
SHA256, explicit cancellation and unknown-result disposition.
- [ ] Run the focused process-effect matrix, complete Gateway/root/UI gates,
adapter compatibility, local builds and original privacy/complete-history review
before scoped non-force publication. Real provider/platform/deployment acceptance
remains independently required; commit is not a remote push permission.
