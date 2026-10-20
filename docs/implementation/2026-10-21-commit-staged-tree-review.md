# Original commit review: verified staged-tree evidence

Continue the [complete original Git commit plan](../superpowers/plans/2026-10-21-original-git-commit-chain.md),
not a replacement scope. DSH planning, original owner/review/atomic receipt,
same physical DB and native/Worker/workspace custody remain unchanged.

## Source comparison and gap

The pinned PilotDeck repository-operation implementation checks an expected
`write-tree` OID before running Git commit through its original repository
coordinator. Jot already has an explicit commit review but its witness contains
worktree bytes plus a raw index hash, without independently validated staged
objects. A real fixture with a missing staged blob or a tree object masquerading
as an index blob still obtained a prepared review in the original code. Those
are actual behavioral red tests, separate from any future execution authority.
The source inspection motivates exact staged-tree evidence; no AGPL source was
copied into this independently implemented Apache-2.0 module.

## Original flow strengthened

The existing review prepare/approve calls now select `freezeCommit` only for
commit. It first retains the ordinary exact review witness, then opens the
same controlled disposable metadata-copy mechanism. Fixed internal commands
inventory full stage0 paths/modes/OIDs, render a tree with private object output,
compare its recursive tree to that inventory and batch-read referenced blobs.
Original source objects are read as alternates; source hooks, includes, signing
programs, filters, credential prompts and lazy network fetch are not activated.

Each raw blob is framed by exact type/size, verified against its Git object hash
and independently SHA256-digested. Canonical inventory/blob digests, whole tree
OID, object format and original index digest are stored in the ORIGINAL immutable
review witness. Full source snapshot/root/HEAD/index/metadata observations are
rechecked after awaits; owner identity is rechecked before original DB commit.
No new execution store, queue, schema migration or public operation is introduced.
Stage/unstage retain their original protocol2 witness encoding; commit adds its
own nested evidence without changing those historical receipts.

Known unverifiable staged objects return a safe409 code through the existing
review API, rather than a503 ambiguity that keeps the browser's original request
pending. The error returns no object bytes or host paths. Legacy commit reviews
without the proof cannot silently gain it during a new approval; a fresh review
is required. Historical receipts remain immutable, and cancellation does not
require rereading the broken original object. Commit execution remains explicitly
unsupported by the original execution-source guard; an approved review is no
permission to update refs, write a commit, run hooks/signing or push remotely.

## Executed local evidence

The focused real-repository, original intent and HTTP regression passes29/29.
It covers SHA1/SHA256, parent/unborn HEAD, staged bytes differing from worktree,
source index/ref/object bytes unchanged, missing/wrong-type blobs, stale staging,
owner revocation, legacy review, HTTP409, empty trees after deleting the final
file, binary objects and duplicate-content deduplication, controlled hooks/signing
and already-cancelled observation. Expected single-file tree IDs are independently
computed from canonical Git tree bytes, without first populating source trees.
The cancellation test was then strengthened to remove the obsolete reviewed blob
before cancellation; the frozen full Gateway gate exercises that exact version.

A separate external local probe corrupts a cached tree object's raw encoding.
Git's actual `ls-tree` path rejects its hash mismatch. The original frozen review
path likewise rejects it; no speculative extra implementation was added. The
probe's initial read-only-file fixture error and incorrect expectation that Git
would accept a bad loose-object hash are retained as fixture/investigation errors,
not reported as product regressions or fixes.

Frozen candidate typecheck, Gateway/frontend local builds, root67/67, UI289/289
and public-verifier6/6 pass. The complete Gateway gate subsequently finished2329 tests:2322 passes, seven
conditional skips, zero failures/cancellations. All1152 enumerated source/root/test
inputs remained unchanged. This includes the strengthened cancellation case.
These are local synthetic/SDK/browser results, not real-provider or deployment
acceptance. Exact integration, privacy and history checks precede upload. No production, real model,
credential or user data was used. Source/privacy and complete Git-history gates
still precede any eventual scoped non-force upload.

## Required continuation

Commit metadata/author policy, exact original parent/ref and message, immutable
original acceptance, native typed commit effects, CAS/ref/log journaling, producer
settlement, process-loss reconciliation and actual mobile commit/reload still
require Tasks2–4. A commit receipt must never be manufactured from the index-only
receipt. Existing reservation and journal readers explicitly distinguish only
their current kinds; each must be audited before any original schema extension.
This increment does not complete Git row15, the full26 ledger or the broader
portable Chat/Work/provider/platform/deployment acceptance.

## Integrated source verification

The integrated release directory matches the frozen1152 source/root/test input
hashes. Local integrated typecheck, Gateway/frontend builds, root67/67, original
commit/intent/HTTP29/29 and public-verifier6/6 pass without changed source.
The full candidate Gateway2329 and UI289 results remain distinct complete gates;
no narrow integrated test is substituted for either. Schemas, operation manifest,
original BFF, native adapter, execution guard and capability declarations are
unchanged. Current metadata is proof for review, not a new physical commit grant.
