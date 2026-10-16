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

## Lease-fenced live steering implementation

An opt-in `GENERAL_AGENT_ORDINARY_STEERING_ENABLED=true` now requires ordinary
input recovery to be enabled. It defaults off. The Worker exposes only its
original ready execution's frozen Session and live lease. The Dispatcher
checks the existing command binding before native send and again inside the
product-message transaction after acknowledgement; a replacement lease cannot
be borrowed by an old Worker.

Steering uses a distinct `ordinary_steer` envelope and the official command ID
as its RPC. The Adapter proves normalized native text against the read-only
binding before publishing an immutable protocol-3 steering admission. Original
protocol-2 admissions and entry-reservation protocol 1 remain unchanged. The
live recovered Host admits another human RPC only through that exact scoped
admission. Retry deduplication does not create another Controller input.

The real local SDK case `steer-live-recovered` restores the original run,
holds its first scripted model response, dispatches a real product steering
command, and then observes two native human RPCs, two scripted model calls,
two usage records, one product run and one canonical answer incorporating the
supplement. Repeated dispatch, polling and restart do not repeat the input.
This is local live-composition evidence, not production or provider billing
acceptance.

This checkpoint does not complete B/C in full: two supplements, concurrent
command ordering, lost-ack reconciliation and cold multi-RPC admission remain.
The later-step claimed guard remains in place. Stage D, historical terminal
acceptance and stage E monetary/rollout gates remain unfinished. In the opt-in
path, a terminal ordinary parent's pending command stays pending instead of
speculatively creating another run; do not treat that conservative state as
successful delivery. The pre-insertion state/version transaction improvement
also remains on the follow-up checklist. Production switches stay off.

Checkpoint verification: the complete real local SDK ordinary-input suite
passes 20/20 with no skips (270.71 seconds), including live steering. Adapter
446/446, Gateway 1150 passed with six existing skips and zero failures (1156
total), root 32/32 and public-review tests 6/6 pass. Windows Gateway and root
builds pass. No production deployment or enablement is included.

## Next cold multi-RPC implementation boundary

The reviewed rc2 driver appends `step/end` in a `finally` block. It is a
structural boundary, including error paths, and must never be converted into a
successful-call or settled-fee assertion. Prior provider/tool events and unknown
outcomes stay in the original log and accounting holds.

Implement the remaining composition in this order:

1. Preserve the single-input pending-wake protocol and add a separately named,
   explicitly versioned message/RPC binding capability. Match the entire inbox
   in original queue order, exact IDs and exact human sources inside native
   maintenance. Keep the same process-local wake-token custody and revocation.
   A map that is correct except for one RPC, order, duplicate, extra message,
   changed sequence or user cancellation must refuse without a wake.
2. Add cold per-message authority reads to the existing parent-bound preflight.
   Resolve a command RPC only to that same parent's protocol-3 private admission,
   normalized content hash and exact native message. Do not infer ownership from
   a prefix, a command-like ID or a generic user source. Original protocol-2
   admission remains distinct. Compare immutable facts again after each awaited
   setup/adoption boundary. A lease replacement cannot reseal old receipts.
3. Allow an already-consumed parent input to remain history only when recovering
   different, proven unentered candidates. Candidate IDs already committed as
   user messages are still rejected; do not re-prompt the root to give a later
   command a parent. Original completed log prefixes, artifacts and usage must
   be byte-for-byte preserved.
4. For claimed inputs, derive only the final claim window after the last fully
   closed native step. Validate the whole original log with package invariants,
   match each step/turn and prove no later step/request/tool entry exists for
   those candidates. Exclude all prior claimed/committed messages from the
   restore plan. Keep rejection of an open/invalid step, explicit canceled claim,
   unknown input source, later work and any existing entry reservation.
5. Thread these facts through original factory before/after setup, mandatory
   admission adoption, parked observer and original Worker publication. Do not
   make a second Session, prompt, planner, activation or ordinary follow call to
   bypass the reviewed maintenance path. Keep native Goal active/disarmed states
   and actual user pause/stop/cancel separate.
6. Hard-kill the actual Host after a later command is claimed but before entry.
   Restart under a new original-run lease and prove prior calls are not repeated,
   only the proven remaining inputs enter, canonical delivery happens once, and
   all earlier usage/unknown costs survive. Pair with kill-after-reservation,
   mutated command/content/profile, foreign owner, canceled input, two queue
   targets, setup cancellation and replacement-lease refusals.

Live lost-ack tests do not prove this cold path or historical terminal
reconciliation. In-flight Controller work may have accepted input even when a
product command remains pending and a cold buffered event is absent. Terminal
fallback therefore still needs settled original-operation custody and read-only
historical native/admission reconciliation before any new enqueue is considered.

## Transaction and additional live acceptance

Steering now acquires the immediate transaction before reading parent ownership,
state and expected version. Three real two-connection SQLite tests commit a
competing owner, cancellation or version update immediately before acquisition;
the old source wrongly inserted all three commands, and the fixed source refuses
without a command or open transaction. Existing idempotency and dispatch remain.

Two additional actual-SDK scenarios pass: two supplements queued while the first
model reply is held (including equal command timestamps), and an injected lost
acknowledgement after real native acceptance followed by retry of the exact
command RPC. The latter leaves product command/message state uncommitted until
retry, then confirms one native input and one canonical final answer. Two
supplements are consumed in queue order in one additional native model step,
not assumed to require one model request per message. These are live tests;
unknown terminal acceptance and cold replay still require their separate gates.

The separately versioned per-message pending binding capability described above
is implemented in the isolated runtime compatibility preparer. Pure transform
refusal tests and an installed native-driver test verify exact two-RPC order,
no inbox mutation, one model call, local wake-token revocation and stale-token
refusal. Legacy single-input and process-death tests also pass. Product cold
preflight/adoption and completed-step claimed restoration remain unwired.

Verification for this follow-up: Gateway build and full suite pass (1159 total,
1153 passed, six existing skips, zero failures); root 32 tests and Windows build
pass. The full ordinary-input local SDK suite passes 22/22 with no skips in
298.15 seconds. That process had already loaded the original compatibility
transform before the additive binding capability was authored; it verifies the
transaction and expanded live steering scenarios, not the newly prepared
binding capability. The final compatibility source separately passes all 448
Adapter tests, including installed multi-RPC driver, legacy wake and process
crash/cancel probes. A fresh actual-Host focused run against that final source
is recorded separately below. All providers remain local scripted fixtures.

Fresh final-source actual-Host verification passes all five focused cases with
no skips in 64.81 seconds: original claimed restoration, entry-reserved refusal,
one live supplement, two live supplements and native-accepted lost-ack retry.
This confirms legacy Host behavior with the additive compatibility package;
it still does not invoke or prove product cold multi-RPC composition.

## Cold pending command composition

The existing ordinary recovery preflight now resolves each pending human RPC to
its original parent or a read-only command binding for that exact parent. It
checks owner/conversation/original input identity, normalized native text and
immutable command facts before resolving an Agent, again after awaited audits,
and inside execution guards. A pending candidate whose ID or RPC already
appears as a committed human input is refused. A previously consumed parent can
remain history while distinct proven commands are recovered; it is never
re-prompted or re-admitted.

Mandatory admission adoption now accepts the original protocol-3 command
receipt, full native message hash and original reviewed profile. It refuses an
existing entry reservation, changed command or unavailable binary, and rebinds
only local guards to the new exact Worker lease. The original immutable receipt
is not replaced. Mixed-RPC maintenance uses the separately named native binding
capability and preserves queue order and exact-token revocation. Old single-RPC
maintenance retains its previous request contract.

Actual local SDK tests complete a prior model step, queue one or two real
Dispatcher commands behind a native turn-stopping barrier, flush their original
admissions, and SIGKILL the Host. The first observed Runner uses the manually
held original lease; it is not a killed first Worker process. A fresh original-run
Worker then restores the same Session under the next lease, executes only the
pending command(s), preserves the complete prior native prefix and usage, and
publishes one canonical answer. Earlier receipt and reservation bytes remain
identical; only the command entry reservation is newly written under the new
lease. Poll/restart does not repeat calls. Two pending commands retain distinct
RPCs and order while sharing one subsequent model step.

Paired actual-Host tests reserve the command entry or alter its durable command
payload after original admission. Recovery then interrupts with no additional
model call, canonical answer or replacement admission. The first acceptance
attempt also exposed a test mistake: native internal `user/message` records were
counted as human RPCs. The corrected assertion selects source kind `user` and
still compares the complete original history prefix.

This closes local **pending** multi-RPC composition, not later already-claimed
command restoration. The original claimed-factory filter and whole-turn started
step guard are deliberately still present. Later-claim window derivation,
historical terminal lost-ack reconciliation, explicit Goal reactivation,
unknown provider/tool costs, consumer upgrade/rollback and production/real-provider
acceptance remain required. Native usage preservation is not monetary settlement.
Production defaults remain off and the complete 26-capability scope is unchanged.

Final validation for this checkpoint: complete real local SDK suite 25/25,
zero failures/skips, 298.08 seconds; the subsequently added two-command cold
case separately passes in 17.65 seconds. These are 25 full-suite cases plus one
focused case, not a claimed single 26-case run. Adapter 454/454, root 32/32,
public-review tests 6/6 and Windows root build pass. Gateway source is unchanged
in this checkpoint, so the prior Gateway results retain their own scope.
No production deployment, real-provider quality or monetary settlement is claimed.

## Later claimed command restoration

The ordinary claimed-input policy now explicitly enables a closed-step claim
window. The generic native helper remains conservative by default. With this
policy, the complete cold log first passes official package invariants. Matched
step/turn boundaries select only the removals after the final structurally closed
step; open/mismatched steps refuse. Prior steps, model/tool events and usage stay
in the log untouched. A claim followed by a started step is not restored from a
missing buffered event. Neither a real nor repair-generated step closer proves
successful provider/tool outcomes or settled money.

For every restored command, the unpublished factory requires its exact current
parent-bound Gateway command identity and original immutable protocol-3 receipt,
full native message hash and reviewed composition. Candidate entry reservations
still prohibit replay. Command proofs are rechecked across admission reads and
again after preset setup, before publication. Changed proofs or new competing
entry reservations cannot pass the after-setup gate. Original protocol-2 input
restoration and the separately owned Goal/approval sources retain their contracts.

Actual local SDK cases complete an original model step, accept one/two durable
commands, let the real driver claim them, and hold before the next step starts.
The Host is flushed and SIGKILLed. Startup cold projection shows no pending
command, so recovery uses the original unpublished factory rather than a prompt.
The real recovering Worker then consumes only the restored commands, preserves
all earlier native prefix/usage/admission/reservation bytes, creates each new
command entry under its current lease and publishes one canonical answer.
Poll/restart adds no calls. As in the pending fixture, the first Runner lease is
held by the test; this does not claim a killed first Worker-process test.

Paired actual-Host faults reserve the candidate's entry or change the original
command payload before restart. They interrupt without another model call,
canonical answer or rewritten private admission. The first real claimed case
failed with an interrupted parent and no published Agent; after the original
factory was connected to command proofs, it passed. Local scripted-provider
four-case acceptance is recorded separately from production or monetary evidence.

This implements the local completed-step/unentered-claim composition. It does
not settle historical terminal acknowledgement loss, unknown dispatch/provider
fees, explicit Goal reactivation, consumer upgrade/rollback, real-provider quality
or production acceptance. Those gates and the complete 26-capability objective
remain in force; production defaults stay off.

### Mixed claimed and surviving-pending input

Review found an additional execution gap after the first 30-case local suite
passed: the cold projection can contain a later pending command while an earlier
command has already been claimed but not entered. Resolving the nonempty queue
directly skipped the claim factory and lost the earlier command. A corrected
actual-Host case reproduced two entry records where three were required; this
was an implementation failure, not a test-count adjustment.

Interrupted history with configured claim recovery now always passes through the
original unpublished factory even when pending input survives. An explicit
`allowPending` scope permits a verified unchanged nonempty queue when no restore
is needed; it is not the default and does not grant execution. If the final
interrupted claim window may contain removals and no claim factory is available,
preflight refuses instead of proceeding with an incomplete queue. All surviving
messages, not only newly restored claims, require original immutable admissions
before publication and are rechecked after preset setup. This also rejects a
missing admission in an otherwise unchanged surviving queue.

The real mixed case now restores the earlier claim ahead of the later pending
message, preserves old native/usage/private records, creates both command entries
under the new original-run lease and publishes one answer without repeating the
first model call. The earlier 30/30 result is retained as a pre-fix checkpoint,
not final-source coverage of this new case. Final 31-case and Adapter results
are recorded below when their actual processes complete.

### Next delivery-race work

A command's `applied` state proves native acceptance, not that the final answer
covers it. Before adding historical terminal fallback, test the boundary where a
new command is durably inserted as the Runner observes `turn/end`, including an
acknowledgement lost after native acceptance. Inspect both the original follow
stream's human RPC coverage and the Worker's final publication transaction.

The next implementation must fence publication against commands accepted during
that boundary. Keep the owning original Worker lease and original native stream
until its verified command inputs are covered; recheck the command set inside
the same transaction as canonical finalization. Do not treat a pending/applied
flag or an old nonempty answer as coverage of a later RPC. A lost response must
reconcile original native admission/entry/history before any new run or prompt.
This is a proposed Jot integration boundary, not a claimed upstream API or a
second scheduler. Preserve user cancellation and unknown dispatch/fees. Read-only
historical terminal reconciliation remains separate from permission to resume.

Final-source verification: complete actual local SDK suite 31/31, zero failures
or skips, 389.65 seconds, including the mixed claimed/pending regression. Adapter
463/463, root 32/32, public-review tests 6/6 and Windows root build pass. Gateway
source is unchanged, so its earlier suite is not represented as new evidence.
All SDK providers are local scripted fixtures; no production deployment or
monetary acceptance is included. The earlier pre-mixed 30/30 run remains
historical evidence only. The full objective stays active.
