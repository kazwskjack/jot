# Native workspace family maintenance barrier

Part of [original Git execution and workspace coordination](../superpowers/plans/2026-10-19-git-index-http-workflow.md).

An idle observation is not an exclusive workspace grant. The installed DSH driver
also reports `idle` during maintenance, but `runMaintenance` owns the actual driver
phase and latches new wakes until its callback finishes. A status check alone can
therefore race an incoming message or another maintenance operation.

## Implemented host primitive

`packages/session-adapter/native-workspace-barrier.js` composes the existing native
handoff barrier for every original resident Session in a workspace family. It
acquires handles in deterministic Session order, retains all handles through the
awaited physical callback, and releases all acquired handles on success, failure
or cancellation. It never waits for its own maintenance job to become idle.

Every member retains the original registry instance, Session, log prefix, inbox,
tool guard and model guard. Background web batches require the existing terminal
operation reconciliation. An armed Goal, changed Goal revision, missing service,
pending input or changed member invalidates the barrier. The official Goal
service's `undefined` no-current-Goal result remains valid. No Goal is disarmed,
and no user input is cleared or consumed by this primitive.

The caller must already hold the owning workspace reservation that fences member
creation, shared writers and checkpoint restore. Its synchronous original
ownership/membership check runs across acquisition and dispatch. An asynchronous
check is rejected. This primitive cannot turn caller-supplied Session names or a
read-only idle observation into that reservation. All acquired native cancellation
signals also reach later member captures and the one physical callback.

If a message arrives after dispatch, the post-dispatch check rejects the result
but preserves the message. This does **not** prove that no filesystem effect
occurred. The original producer/effect journal must reconcile that outcome;
automatic retry is not justified by a failed barrier return.

## Verification

- Test-first missing-module failure, followed by passing family barrier cases.
- Additional failing cases exposed an incomplete Goal identity check and missing
  outer-to-inner cancellation propagation; both now pass.
- Installed official DSH `0.2.1-rc.2` driver and Goal service: two real Agents
  remain under maintenance while an awaited file operation completes. Nested
  maintenance is refused. A follow-up received during the callback makes no
  model call until maintenance releases, then appears exactly once in the native
  persisted user-message log and invokes the synthetic local model once.
- Focused family, handoff, idle-observation and installed-runtime suite: 45 pass,
  zero failures or skips. Packed adapter includes and imports the primitive.
- Adapter baseline: 760 pass, 26 conditional installed-runtime skips. The suite
  with the new SDK enabled passes 777 and fails nine unchanged memory tests
  because that SDK fixture lacks the separately pinned memory plugin. The old
  memory integration separately passes all 12 tests with its reviewed runtime.
  These are separate results, not a claim that the mixed fixture is green.

The runtime test uses only a synthetic local model and disposable test files;
it does not contact a production provider or use user conversations.

## Remaining integration

This increment is a host prerequisite, **not** workspace write activation. No
HTTP mutation route, Git write UI, original Worker drain or production feature
flag is enabled here. The owning project reservation, actual source/isolated/Git
root relationship, shared-file publication, native member admission and checkpoint
restore still need to join the original Gateway lifecycle. Nonresident Sessions
also need original cold-state and membership evidence; an empty live registry
alone proves nothing. The caller cannot omit them merely to acquire a barrier.

Keep every coordination checkbox open until the actual React/BFF/Gateway/Worker/
native path passes with the original physical repository, current ownership,
original approvals and durable effect receipts. The full capability ledger and
portable Chat/Work release remain open.
