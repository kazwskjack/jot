# Ordinary steering lineage and recovery

Status: implementation in progress. DSH remains the planner and uses its original `steer` / inbox / step machinery. Do not enable production continuation until every gate below passes. This plan continues the existing full backend and 26-capability scope; it is not a replacement completion criterion.

## Verified gap

`SessionCommandDispatcher` submits the durable command ID as the native RPC ID. Initial input uses its run ID. The ordinary recovery Host currently accepts only the original run RPC, while the command dispatcher does not supply a durable ordinary-input admission binding. A legitimate supplement can therefore be classified as foreign after recovery. Merely accepting arbitrary RPC IDs, reusing the run RPC, or resubmitting the initial prompt would break ownership/deduplication.

Native rc2 claims input before `agent/pre-step`, appends `step/start` only after its enter decision, and can execute multiple steps inside one turn. The current claimed-restoration helper refuses any started step in the interrupted turn. Supporting a later unentered steering claim therefore also requires a verified completed-step boundary; deleting the existing guard is insufficient.

## Required boundary

1. Keep one original product run, conversation, owner, Session and exact live Worker lease. Each steering command retains its own native RPC and one deterministic product-message identity.
2. Add a read-only internal command binding derived from the existing command/run/message records. Return hashes and IDs, never user text, credential data, a new lease or execution authority. Pending/applied status must not change its immutable identity.
3. Keep product text representation and the existing native wire normalization distinct. Hash the exact deterministic product content and normalized native text parts, so the Host can prove its final native message actually matches the accepted command.
4. Verify command state, parent lineage, owner-bound Session, live lease, original input, exact payload and any already-persisted product message. Reject collisions, foreign commands, superseded/cancelled controls and missing/corrupt applied-message records.
5. Keep admission/entry reservation per native message. Original protocol-2 records remain original-input proofs; steering needs an explicit versioned RPC/command proof. Do not silently migrate or reseal historical records.
6. Keep original native steer semantics. Do not replace the native RPC with the parent run ID, create a competing planner, concatenate a second prompt, or weaken cancellation/permissions/entry reservations.

## Implementation and acceptance order

### A. Internal identity proof

Files: add `packages/gateway/src/conversations/ordinary-steering-binding.ts`; register it in `server.ts`; tests under `test/routes/ordinary-steering-binding.test.mjs`.

- Reuse `inspectOrdinaryInputBinding` inside the same immediate transaction for original owner/run/input/Session/lease authority.
- Read the exact existing steering command and accepted payload. Derive its deterministic product message using the dispatcher's current representation, and its normalized native text content using current prompt rules.
- Accept only pending/applied commands belonging to that parent. Require an applied message to exist and exactly match; reject collisions on either deterministic ID or client ID.
- The receipt has `execution_authorized: false`. Reading it must not write the database, enqueue a message, activate a Host, acquire a lease or settle cost.
- Tests: read-only stable receipt; pending-to-applied continuity; owner/run/Session/lease mismatch; body spoofing/authentication; malformed/blank payload; wrong command kind/state; conflicting or missing canonical messages; no raw text in response.

### B. Lease-fenced dispatch and native admission

Files: `harness/worker.ts`, `command-dispatcher.ts`, `main.ts`, `session-controller-client.ts`, adapter transport/binding/admission modules.

- Obtain the originally owned live Worker lease from the actual ready execution, not by borrowing the current database lease after replacement.
- Carry parent run plus command identity through a separate validated steering metadata contract. Apply only to ordinary chat when the existing recovery configuration is explicitly enabled; keep workbench/Goal authority separate.
- Recheck ready owner/lease and command facts before send and before canonical persistence. Resolve lost acknowledgements using the same official RPC/admission proof.
- Verify final native content hash equals the command binding before publishing a versioned steering admission. Preserve actual user cancellation, original attachments and native entry reservation.
- Tests: stale ready Worker; replaced lease; terminal/cancelling race; no duplicate product/native input after lost acknowledgement; native content mismatch refusal.

### C. Multi-RPC live ownership

Files: ordinary input authority/admission/run Host, factory policy and stores.

- Resolve each pending or claimed native human RPC to either the original input or a verified command belonging to the same parent run.
- Keep exact per-message hashes/admissions/reservations and original native queue order. An unrelated human stays foreign.
- Do not revoke a recovered run merely because an authorized steering command uses its own RPC. Do not let a completed earlier parent message authorize another input.
- Tests: original plus two supplements; authorized versus foreign command; concurrent commands; pause/stop; delayed receipt from old observer; entry-reserved steering refusal.

### D. Completed-step claimed recovery

Files: `native-claimed-input.js`, `ordinary-claimed-input.js`, compatibility/factory acceptance fixtures and invariant replay.

- Derive the unentered claim only after a fully closed previous native step, with no subsequent input/model/tool entry for that claimed message.
- Preserve completed steps, usage, tool receipts and unknown outcomes. An earlier settled step does not authorize repeating its provider/tool calls.
- Use original invariant replay and exact source/provenance. Do not remove blanket guards until narrower verified boundaries exist.
- Real SDK tests must hard-kill after a later steering claim, then prove the original parent is not re-prompted, only remaining input enters, and one correct final answer is published.

### E. Delivery, accounting and rollout

- Reconcile native admission, command status, deterministic product message and original Worker publication. A progress reply is not final delivery.
- Preserve unknown provider/tool costs and existing entry reservations. No inference of free calls from absent buffered events.
- Cover initial/recovered running tasks, two supplements, lost acknowledgements, restart, foreign owner, cancelled tasks, actual pending and later-claimed inputs, and a lease replacement.
- Run Gateway tests/build plus root tests/Windows build; run adapter and real SDK gates for their changed sources. Retain failures and distinguish scripted-provider fixtures from production acceptance.
- Update docs and private progress records, exact-commit sensitive-data scan, push the existing development branch. Keep production switches off until the full composition, upgrade/rollback and real-provider gates pass.

Stage A alone does not repair end-to-end steering. Stages B–E remain required before claiming completion or enabling production behavior.

## Stage A implementation record

The route and eight focused real-Gateway tests are implemented. They verify
read-only pending/applied continuity, exact authentication/envelopes, original
Session/lease/owner scope, stopped parents, unknown commands, command kind/state,
malformed/blank payloads, future versions, canonical-message consistency and
client-ID collisions. The endpoint has no Controller/dispatcher dependency and
returns no execution authority. Gateway TypeScript/build passes. Full suite
validation is recorded with the resulting implementation commit. Stages B–E
remain unfinished; Stage A must not be represented as end-to-end steering.

## Additional ordering requirements found during source review

- `worker.isReady` is currently a local boolean. Later dispatch must retain the
  lease originally owned by that ready execution, then compare it to the live
  database lease. Reading the replacement lease from the database must not let
  an obsolete Worker borrow the replacement's authority.
- `WorkbenchBridge.request` serializes known binding fields; command identity
  needs an explicit validated envelope. Do not rely on arbitrary object fields
  being forwarded. A steering binding cannot be used with queue mode or the
  ordinary initial-input metadata contract.
- Native `step/end` can belong to a previously recovered/unknown attempt. A
  closed native step is not a provider-cost settlement. Restoring a later input
  must preserve unknown tool/model facts and must not repeat prior calls.
- Terminal fallback needs lost-acknowledgement reconciliation **before** it
  enqueues another run. A command may already be accepted or entered in the
  original native Session while its product status remains pending. The new
  active-lease binding intentionally refuses terminal parents; historical
  read-only reconciliation must remain a separate non-executing authority,
  checked against original admissions/native RPCs before choosing fallback.
- Product command `applied` certifies accepted delivery, not model completion.
  Preserve human cancel/stop even if a late acceptance is discovered; never
  turn it into implicit task resume.
- Move steering admission's parent state/version checks into the same durable
  transaction as command insertion when wiring dispatch. Source review found
  the current checks precede that transaction. Revalidate after awaited send
  before recording product delivery, and resolve uncertainty explicitly.

Stage A validation: all eight focused route tests pass; the complete Gateway
suite reports 1151 tests, 1145 passed, zero failed and six existing skips.
Gateway TypeScript/template build, 32 root tests and the Windows root build
pass. No Adapter/native execution source is changed by Stage A, and no
production switch or steering dispatch path is enabled by it.
