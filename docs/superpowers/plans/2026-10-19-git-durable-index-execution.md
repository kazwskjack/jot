# Durable original Git index execution implementation plan

> Continue the approved Git workbench task 4 with executing-plans, without
> subagents. This plan does not replace the full capability ledger or open a
> general Git/shell tool.

**Goal:** execute an exact owner-approved stage/unstage request once, retain its
original dispatch and outcome, and reconcile actual effects after process loss.

**Architecture:** use the existing project ownership, original review journal,
SQLite transaction and HTTP command conventions. The configured original
repository is the effect target; controlled metadata copies compute bytes only.
DSH remains the sole planner. Recovery observations do not authorize execution.

**Tech stack:** existing Node filesystem/Git transport, DatabaseSync immutable
rows, original transaction helper and actual child-process crash fixtures.

**Spec:** [full Git workbench task 4](2026-10-19-git-workbench.md),
[current internal kernel](../../implementation/2026-10-19-git-index-effects.md).

## Constraints

- Retain owner, approval version/digest, cancellation, source-byte witnesses,
  physical binding, active-execution exclusion and immutable original receipts.
- Freeze attribute dependencies during review, including ignored/missing files.
  Legacy witnesses cannot silently gain execution authority.
- Persist original dispatch evidence before any source object write. Identical
  index bytes from an outsider are not proof of the original publication.
- A completed historical receipt cannot grant fresh authority. Read historical
  results under current ownership, separate from permission to execute.
- Unknown effects must not be replayed. File/index observations are not database
  rollback. No credential, root, command or executable override from a caller.
- Source object orphans, incomplete lock acquisition, live workers and lost
  acknowledgements require separate evidence; do not call them all success.
- No production activation. Builds and fixtures run locally. Publish only source,
  synthetic fixtures and reviewed documentation, with no runtime journals.

## 1. Original approval dependencies

- [x] Add failing tests for ignored attribute changes before approval and after
  approval but before preparation, and for a previously missing attribute file.
- [x] Extend the internal exact-review witness with a versioned sorted attribute
  manifest. Capture and recheck its bounded hashes while reading the snapshot.
- [x] Require that witness in the index kernel. Existing original review and
  intent digests continue to bind it; old witnesses require a fresh review.
- [x] Preserve original index/shared-index mtimes in controlled copies so Git's
  racy-stat detection remains valid. Add a deterministic copy/source timestamp
  regression and retain the original same-size attribute-change assertion.

## 2. Durable physical observation

- [x] Capture a bounded strict internal evidence record from the existing opaque
  plan: original repository/directory identities, source digest, exact index
  digest/owned file identity, refs and referenced blob hashes/sizes.
- [x] Persist this record synchronously before source object dispatch. After a
  real process exit, reconstruct only a read-only observer from trusted original
  storage; never deserialize a new writable plan from a request.
- [x] Exercise real child exit before publication and after physical publication
  but before the SQLite outcome commit. Reject corruption, foreign matching
  bytes and changed physical roots. Never count a simulated throw as a real
  process-crash test.

## 3. Original execution and recovery journal

- [x] Connect the existing owner-approved intent to a stable original execution
  request, version/hash checks, active repository exclusion and immutable
  dispatch/outcome rows. Recheck current ownership before cached reads.
- [x] Store dispatch before the first source object write; atomically record the
  actual kernel receipt with the original execution outcome. Inject failed
  outcome persistence and recover without another Git mutation.
- [x] Reconcile after process loss against the original record. Active workers
  are not dead merely because a timer elapsed: revoke/fence the original lease
  before owned-lock recovery, preserving the final synchronous commit fence.
- [x] Recover incomplete lock acquisition from durable owned-file identities;
  do not delete unproven conventional Git locks. Keep execution admission closed
  until the remaining disposition and original API/UI boundaries are resolved.
  Prepare private same-filesystem files first; commit their strict identity/hash
  manifest in a root transaction before exclusive hard-link placement at Git
  lock names. Place synchronously inside a separate original lease/approval
  transaction. Exercise actual exit before manifest commit and before/after
  link/unlink, including a two-name inode. Preserve unknown links/files.
- [ ] Add explicit original owner-reviewed disposition for unresolved execution
  records. Lock cleanup is not task success, rollback or permission to replay.
  Distinguish protocol-2 pre-dispatch evidence from legacy unknown acquisitions;
  preserve original applied receipts and exact control acknowledgements.
  Preserve unresolved-repository exclusion across stamp-encoding/program changes
  for the same project/configured repository; a changed fingerprint is not a
  free execution slot. Exercise old stored bindings rather than only old table
  schemas populated with newly generated witnesses.

## 4. Original API/UI execution admission and release

- [ ] Mount only through existing authenticated/CSRF/idempotent atomic-command
  contracts and original exact request recovery. Synchronize schemas, operation
  manifest, BFF and types. Historical review approval is insufficient.
- [ ] Add explicit execute/result controls to the existing review UI; preserve
  request/body across lost responses and show unknown/current/historical states
  separately. Verify real mobile BFF/Gateway/index effects and restart recovery.
- [ ] Run focused and complete regressions and local builds, inspect source and
  exact staged/history objects, publish the scoped commit and compare remote
  commit identity. Keep commit/destructive/revert/remote/full-ledger work open.
