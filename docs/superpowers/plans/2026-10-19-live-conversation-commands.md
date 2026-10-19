# Original live conversation commands

Continue the already approved portable Chat/Work and native composition plans.
User intent is to supplement the currently running task immediately. Preserve
DSH as sole planner, original owner/permissions/leases and command admission.

## 1. Atomic original command receipts

`server.ts` already caches completed HTTP responses. The missing boundary is a
crash after the steer/cancel transaction but before its response cache commits.
Reuse the existing `atomicCommand`/`ga_idempotency` protocol on these two routes;
do not add another command store or infer success from mutable run state.

- First add real API tests injecting a response-receipt SQL failure. Assert
  command, cancel state and events roll back together; exact retry may complete
  only a new reserved atomic request. Cover disk reopen, changed body, foreign
  owner and old unknown rows without the new protocol. Old unknown rows refuse.
- Add the two routes to a dedicated receipt protocol and execute original
  business guards, command writes, contract validation and response receipt in
  one existing immediate transaction. Move direct cancel's row read under its
  write lock and test competing owner/status/version changes.
- Preserve existing completed-response replay, original Dispatcher custody and
  native checks. A receipt acknowledges command acceptance, not native execution
  or final success. No fresh-run fallback is introduced.

## 2. Current-page text steering and cancellation

`RoleChatController.send` currently always submits another conversation message,
and the UI labels active submission as queueing. Route an explicit ordinary
active-task text supplement through the existing `/runs/:id/steer` contract.
Freeze original target, body, expected version and idempotency key before I/O.
Unknown responses retry the original command even after mutable state changes.
Keep `IDEMPOTENCY_IN_PROGRESS`, timeout, malformed successful identity and 5xx
outcomes pending. Definite refusal refreshes current owned state without replay.

Add a separate immutable current-page cancel command; the existing UI currently
generates another key when retrying cancellation. Prevent conflicting pending
settings/actions and retain draft text. Do not persist these browser commands
under an invented owner namespace. Keep existing departure warnings and expose
the current-page limitation honestly. Original Role/Goal flows remain distinct.

First test controller behavior, then actual mobile React/API transitions with
ambiguous replies. Finally use original BFF/Gateway/Worker/Dispatcher/installed
SDK for live supplementation and cancellation, observing actual command receipts
and one final answer rather than creating another conversation/run.

## 3. Attachment continuation is a separate required boundary

Current SteerRequest, Dispatcher, native steering transport and immutable source
proofs are text-only. Do not serialize a file reference into text and claim an
image was seen, drop an upload, or call this full attachment continuation.
Inspect official pinned content-part support, then version/extend the original
admission/content manifest, resolver and native projections together. Preserve
owner/artifact version/hash and original command identity. The full portable gate
remains open until actual file/image cases and unknown receipt recovery pass.

## Release

Run focused failures/green regressions, full Gateway/root/UI and changed Adapter/
Host tests plus actual SDK cases. Build locally, review exact changed source,
staged data and history, publish explicit paths to the existing feature branch,
then verify exact remote hash. Record skipped/external-provider gates separately.
No production activation or completion of the 26-capability ledger is implied.

## Current batch evidence

Atomic original HTTP command receipts, locked cancellation checks, current-page
Stop recovery and strict ordinary MessageReceipt handling are implemented. See
[executed evidence and limitations](../../implementation/2026-10-19-run-command-receipts.md).
The mobile API case covers a wrong status-read identity and an ambiguous result
after committed cancellation. The actual SDK mobile case observes native cancel,
original cancelled state and no canonical answer. Final local regression passes
1,832 Gateway tests (seven explicit skips), 237 UI and 67 root tests. Actual SDK
Chat serial tests pass 21 plus the selected original Work case, with no skips.

Step 2's immediate text steering and step 3's attachment continuation remain open.
The UI still labels active new input as queueing; do not claim otherwise. Match
trusted owning Worker/admission readiness and prohibit fallback before changing
that flow. External provider and full capability acceptance remain independent.
