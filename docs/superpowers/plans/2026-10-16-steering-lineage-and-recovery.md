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

## Running-turn completion and acknowledgement coverage

A real SDK boundary case now reproduces the next delivery bug: the original
Runner observes `turn/end`, a real Dispatcher accepts a supplement during its
ordinary Goal-state read, and the second model call starts. The previous Worker
still finalized the old answer and closed the observer. The first attempt had
incorrectly preclaimed the Worker's lease and timed out; that attempt is excluded.
After correcting the fixture, the genuine failure was `finished` versus the
required `still-running` while the second model was held. Its defective earlier
test process tree was identified and stopped; no production process was touched.

The opt-in ordinary steering stack now adds a hash-only `input-completion`
inspection. It reads only the existing Agent, exact original/command lineage,
immutable native admissions and current reviewed composition. It does not resolve
an Agent, prompt, wake, reserve an entry, modify persistence or settle money.
Pending/open work yields an observation hint; completed work must have a latest
completed turn, a real final assistant message after every requested human RPC,
no duplicate/foreign current RPC, an empty inbox and stable current identity.
The answer hash and native sequence are checked against the Runner's observed
candidate. Changed receipts/parent or an aborted turn cannot certify completion.

The Runner retains its exact original iterator/cursor for later native work;
it does not open another follow, manufacture a prompt or repeat the original
input. Product acknowledgement settlement can be retried against the same native
facts without another model call. Publication remains a callback owned by the
original Worker: owner, current lease, original input and the complete durable
command set are checked before output resolution and again inside the same
transaction as candidate verification, canonical message and terminal state.
Commands still awaiting their accepted product message block publication. A new
command arriving during output resolution invalidates that transaction's coverage
rather than publishing stale output. The Worker remains ready and renews its lease
until publication; successful publication stops renewal before releasing the
Runner, and late cleanup cannot create another canonical answer.

`GENERAL_AGENT_ORDINARY_STEERING_ENABLED=true` now also selects this delivery
contract and requires ordinary input recovery plus a matching Runner/Adapter.
`ordinaryCompletionProtocol: 1` is an internal Jot integration capability, not an
upstream API or a model-facing tool. The public MCP tool set and DSH planning,
reasoning settings, permissions and actual user cancellation remain unchanged.
The default stays false. Missing/mixed capabilities refuse instead of publishing
through the legacy path; rolling upgrades are not yet accepted.

Two actual local SDK cases pass at the running completion boundary, including
accept-after-send acknowledgement loss. They hold the second model response and
prove no canonical answer is published early; after response and exact-RPC
product reconciliation, one final answer is published with two original model
requests. The full ordinary-input SDK suite now enables the gate for its ordinary
Workers, including pending/claimed recovery, binary and independent Goal states.
All providers are scripted local endpoints.

This closes the demonstrated running completion race, not historical terminal
reconciliation after old deployments or a Host/Worker crash after all input was
entered. Unknown dispatch/fees, explicit concurrent Goal reactivation,
consumer upgrade/rollback, real-provider/deployment acceptance and the complete
26-capability scope remain required. An accepted command, closed native turn or
completion hash is never a monetary settlement or a new execution permission.

Final completion-gate validation: local actual SDK 33/33, zero failures or skips
(414.40 seconds). A fresh two-case run after the last assertion changes passes
2/2 (31.63 seconds), verifying the second model request contains the supplement,
exactly one product run, two human messages and one canonical answer. Final
Gateway suite: 1165 total, 1159 passed, six existing skips, zero failures
(132.95 seconds), including command arrival during output resolution. Adapter
466/466 plus the final strengthened reader's armed-Goal/sequence-race checks
3/3; root 32/32; Gateway and root Windows builds pass. Public-review regression
6/6 and BRAIN link lint pass. Providers remain local scripted endpoints. These
results do not certify historical terminal recovery, production, fees or the
remaining capability inventory.

## Historical terminal reconciliation work sequence

The live binding deliberately requires a running original parent and its live
lease. Do not relax that authority to inspect terminal history. Add a separately
named product-source inspection, versioned as `ordinary_steer_history`, with
explicit owner/conversation/Session/run/command and expected run version. It
returns only original hashes, command/product state and terminal version; no
lease, raw content, accepted-native claim or execution permission. A cancelled
parent remains cancelled. This source read is not a proof of native inactivity.

- [x] Add `conversations/ordinary-steering-history.ts` and its authenticated
  internal route in `server.ts`. Tests first: terminal source facts without
  writes, exact owner/Session/version, missing/conflicting product messages,
  malformed payload, cancellation, running/role/Goal exclusion, strict auth and
  envelope. Keep live binding behavior unchanged.
- [x] Join that source snapshot to independently read, exact-incarnation native
  history, immutable original/command admissions and entry reservations. Compare
  source again after asynchronous native reads. Missing evidence means unknown;
  an entry reservation is not proof that dispatch or completion occurred.
  First make admission reads inspect an existing private directory without
  creating it. Add a read-only `inspectEntry` store capability requiring the
  exact existing admission and validating entry scope, original admission hash,
  observer and original lease. Report only an observed reservation/absence,
  never replay permission or provider completion. Re-read admission across the
  inspection; malformed, changed, missing or cancelled reads refuse. Preserve
  existing exclusive reservation and replay guards. Test missing-root no-write,
  stable bytes, protocol-2/3 records, corrupt scope/hash/lease and cancellation,
  then Adapter and actual SDK suites for the modified storage composition.
- [ ] Reproduce Host/Worker death after native acceptance but before product ACK,
  and after native answer but before product publication. Preserve all original
  RPCs/usage and one parent. Distinguish accepted pending input, entered unknown,
  answered and unproven cases. Never issue a prompt during inspection.
- [ ] Only after these proofs, define an atomic product acknowledgement repair
  and separate final-answer reconciliation. Respect cancellation, owner changes,
  current version and canonical publication. No implicit resume or new fallback
  run. Unknown model/tool outcomes and billing remain separate required gates.

Execute serially in the existing public branch, with Windows local tests/builds,
private evidence outside publication and exact-commit sensitive-data scanning.
This sequence continues stage E and the full inventory; it does not replace them.

### Product-source inspection implementation

`POST /internal/v1/workbench/ordinary-steering-history` is now registered with
its own internal bearer authentication, separate from browser actor/CSRF routes.
The exact request is `owner_id`, `conversation_id`, `session_ref`, `run_id`,
`command_id`, `expected_run_version`; coercible versions, extra lease/text fields
and foreign scope refuse. It reads one transaction and returns a distinct
`ordinary_steer_history` record, original/command/content hashes, terminal run
version/state, command state and whether the exact deterministic product message
exists. Applied commands require that message. Existing collisions, malformed
payloads, future source versions, wrong original lineage, archived ownership,
roles/tasks and Goal controls refuse. Errors never include stored text.

Pending, applied, superseded and rejected are product facts only. The response
always says `native_acceptance: unverified` and `execution_authorized: false`.
It has no execution lease and cannot satisfy the live binding or completion
proof contracts. Reading a cancelled/failed parent leaves it unchanged. An absent
lease does not block this source inspection, and a lingering lease is not treated
as native inactivity. No Dispatcher uses this inspection yet. Native history,
entry/receipt verification and atomic ACK/final-answer reconciliation remain
unchecked items above; historical delivery is not repaired by this endpoint.

Six new actual-Gateway tests plus eight existing live-binding tests pass. The
first red run saw the missing route rejected; after initial registration, the
browser CSRF prehandler still rejected it before internal authentication. Adding
only this exact authenticated internal path fixed that transport gap. The first
build exposed TypeScript control-flow narrowing for an arrow `never` helper;
a function declaration fixed it. Windows Gateway build passes. Complete final
suite and publication evidence are appended after their actual completion.

Historical source checkpoint final validation: Gateway 1171 total, 1165 passed,
six existing skips, zero failures (138.69 seconds). Root 32/32 and public-review
regression 6/6 pass; Windows Gateway/root builds and BRAIN links pass. The first
root run in the restricted sandbox failed loopback connections with EACCES; the
existing authorized Windows-user run passes. No Adapter/SDK execution sources
changed in this checkpoint, so earlier SDK results are not presented as a new
historical-recovery test. Working-tree public review scans 699 files. No native
historical reconciliation, production deployment or permission enablement is
claimed. The remaining sequence above stays open.

### Private admission and reservation observation

`ordinary-input-admissions.js` now separates existing-root validation from
creation. `read`, `readReplayCandidate` and the new `inspectEntry` never create
a missing private directory. Directory creation stays confined to write paths;
exclusive no-overwrite publication and execution reservation remain unchanged.
The regression genuinely failed because a read created the missing directory.

`entryInspectionProtocol: 1` advertises this local storage capability.
`inspectEntry({session,runId,messageId,signal})` requires an existing exact
protocol-2 or protocol-3 admission and rechecks it after reading the entry. It
returns `protocol`, observed `state` (`reserved` or `unreserved`),
`admission_sha256`, the validated hash-only entry (or null), and
`execution_authorized: false`. Entry scope, admission digest, observer, original
lease and exact schema must match. A missing directory/admission, wrong Session
incarnation, invalid/corrupt/oversized record or cancellation refuses. JSON null
in an existing file must refuse rather than masquerade as no reservation; the
additional corruption regression exposed and corrected that distinction.

Reservation observations are snapshots, not stable claims of nonexecution.
`unreserved` cannot authorize replay, dispatch or a new task; all original
replay/entry checks remain mandatory. `reserved` proves only that the immutable
pre-entry fence exists, not model/tool dispatch, answer completion, usage or
fees. No reservation is deleted or renewed by inspection. Native historical
source joining and product acknowledgement/final repair are still unfinished.

The focused storage suite passes 9/9, including unchanged record bytes and
protocol-3 corruption cases. Complete Adapter coverage with the pinned SDK is
469/469, zero skips/failures; the first run without SDK configuration passed
445 with 24 skips and is not complete compatibility evidence. Full actual SDK
composition results are recorded only after that process finishes.

### Native history source review for the next join

The pinned official `SessionController.inspect` reads an attached snapshot or
calls `inspectApiSession`, which observes cold storage with projection mode
`none`; it does not resolve an Agent. However, the cold query's
`readColdSessionLog` appends `interruptedTurnClosers` in memory. Those logical
closers balance a transcript and must never certify actual dispatch, successful
execution, a persisted closing event or money settlement.

Historical reconciliation must distinguish raw persisted event count/prefix
from this logical repaired view. The official raw seam is
`sessionPersistence.open(sessionId, 'read', {signal})`, then
`handle.read(0, undefined, {signal})` and `handle.close()` even on failure. Header
incarnation and inherited count belong to that same handle. Read the verified
product source before opening it and revalidate after awaited reads. No
`resolveAgent`, follow promotion, maintenance, flush or synthetic write belongs
in inspection. Add real-SDK tests showing raw bytes and call counts unchanged,
including an interrupted open step, before using the result to reconcile ACKs.

The next reader, `ordinary-steering-observation.js`, will authorize its exact
scope through `ordinary-steering-history` before opening raw persistence. It
requires no attached Agent/Session in this Host, the original ordinary unseeded
header, a contiguous raw prefix, detached official invariant validation, and
matching protocol-2/3 original/command admissions. Native inbox insertion and
committed user-message facts are distinguished; a missing candidate is unproven,
never safe-to-resend. Persisted completed-turn answer evidence is hash-only and
is not canonical delivery. Original/command profile fingerprints must agree;
this reports the historical fingerprint, not current replay compatibility.
Re-read the raw prefix and product source after awaited receipt checks. Every
handle closes on failure/cancellation. Use this read-only factory in isolation
first; no Dispatcher mutation, execution or production flag is enabled by it.
Tests must cover open raw turns (no synthetic closer), missing/changed evidence,
foreign scope, attached state, receipt/profile mismatch, cancelled parents and
raw/source mutation during reads. Actual SDK/real-storage tests remain required
before any ACK or final-answer repair consumes these observations.

### Historical join implementation checkpoint

The isolated reader now joins the exact terminal source to raw persistence,
detached official invariants, immutable original/command admissions and validated
entry observations. It reads the product source before opening a handle; handles
always close. It refuses live attached Agent/Session state in this Host, seeded
or inherited/foreign Session headers, changed source/version/native prefix,
receipt/hash/profile disagreement, duplicate/conflicting input identity and
cancelled reads. Cancelled product parents may be observed but are not resumed.
The historical profile fingerprint is reported, not adopted as current execution
authority. It neither registers an endpoint/tool nor mutates the Dispatcher.

`native_state` means only `unproven`, historically `admitted`, or native input
`committed`. Admitted does not mean still queued: later cancellation/removal may
have occurred. An answer field is an observed hash and persisted sequence, not
proof of business completion, product publication or cost. Unknown input never
means safe-to-resend. Full ACK/final-answer repair remains open.

Four focused reader tests cover source/receipt corruption, raw open turns,
admission-only/unproven input, attached execution, cancellation, source mutation
and handle cleanup. The first actual SDK lost-ACK/Host-death case passes without
new Agent/model/product output. A strengthened matrix initially used the wrong
fixture field (`fullHistory` instead of emitted `history`) and timed out; that
test-fixture failure is excluded as product evidence. The raw open-step case
passes and confirms cold logical closers do not enter the raw event count.
Final corrected matrix/full-suite results are recorded after completion.

Final storage-composition validation: actual local SDK 33/33, zero failures or
skips (407.97 seconds), including mixed claimed/pending input and both final
publication races. Adapter 469/469 with the pinned SDK; root 32/32, Windows root
build, public-review regressions 6/6, BRAIN links and working-tree public review
pass. SDK providers are scripted local endpoints. Gateway source is unchanged
from the preceding 1165-pass/six-skip checkpoint; that suite was not rerun for
this storage-only change. These checks preserve live/cold recovery behavior but
do not prove historical native joining, ACK repair, real-provider usage/fees,
production rollout or the complete capability inventory.

Full SDK attempt: 35 cases, 34 passed, one failed, zero skipped (421.56 seconds).
The failure was `steer-cold-claimed-two` during initial Host startup: the process
exited with exact `listen EADDRINUSE`, before any Agent creation or model request.
The unchanged original case then passes alone (1/1, 17.73 seconds). Both new
historical cases pass in the full attempt. This is not a full green run: retain
the collision evidence and address the test fixture's probe-close/spawn port
race before final publication. Only an authoritatively exited, pre-ready Host
with this exact bind failure may receive a bounded test-only fresh-port retry;
never restart on observation timeout, unknown failure or after submitting input.
No production behavior, permission or prompt replay should change for this test
infrastructure fix. The current observation implementation remains uncommitted
pending that fix and a complete final matrix.

### Test-only startup bind recovery

`packages/dsh-host/test/startup-bind-retry.mjs` now bounds initial Host startup
to three attempts. A fresh port is selected only after an authoritatively exited
code-1 process reports the exact loopback port's `Error: listen EADDRINUSE`,
before readiness or input submission. Unknown exits, signals, permission errors,
timeouts, ready/submitted work and cancellation never rebind/restart. An existing
live process is never killed by this helper. The fixture updates its own adapter
port and connection URL, preserving the original profile/workspace/Session and
private collision evidence. This is test infrastructure, not runtime failover.

Three helper tests pass, including a real occupied listener and isolated child.
The original failed SDK case plus both historical cases pass 3/3 after wiring.
A new actual DSH case deliberately keeps the selected port occupied; it records
the exited bind collision, rebinds before any model/input request, then verifies
the same lost-ACK historical observation and unchanged bytes. That case passes
1/1 (18.25 seconds). Final ordinary-input coverage is now 36 cases; results
remain pending until the complete final process finishes. Adapter final source
passes 473/473, with no skips. Earlier failed runs remain audit evidence.

Final historical-observation checkpoint: actual local SDK 36/36, zero failures
or skips, 450.72 seconds. The deliberate startup collision is retained in the
private record for `steer-history-port-collision`; this does not imply an audit
of every port allocation by other processes. Adapter 473/473, startup guard
3/3, root 32/32, public-review
regressions 6/6, Windows root build and BRAIN links pass. Exact original native
log and admission bytes remain unchanged in the three historical cases. Gateway
execution sources did not change and its previous suite is not claimed as new
verification. All model providers are local scripted endpoints.

The checked native-join item is implemented as an isolated reader. A deployed
read-only transport/consumer, atomic product ACK repair, final-answer recovery,
unknown usage/fees, real-provider acceptance, upgrade/rollback and the complete
capability inventory remain unfinished. Do not activate production steering or
claim all historical delivery is fixed from these observations alone.

## Read-only historical transport and consumer boundary

Next connect the verified reader to a dedicated authenticated Adapter endpoint,
`POST /v1/sessions/:id/steering-history`, with exact `{history:{owner_id,
conversation_id,run_id,command_id,expected_run_version}}`. Session comes only
from the path. No text, execution lease, action or replay parameter is accepted.
Use existing bearer authentication and generic unavailable/unconfirmed errors.
An authenticated readiness inspection reports capability only, not authority.

Explicit trusted Host config `ordinaryInputHistory: {Session,validateLog}` must
be absent by default. Enabling it requires the original admission store's
inspection capability and the existing internal product bridge; it does not
require activating ordinary replay. Construct only the read-only reader. No new
MCP/model tool or browser route is added.

Add Gateway `ordinary-steering-observation.ts` for strict scope/response DTOs,
and `SessionControllerClient.observeSteeringHistory` for this exact transport.
Validate original owner/conversation/run/command/Session/version, all hashes and
nullable facts, state dependencies and native answer sequence. Reject coercion,
extra fields, foreign identity or any claimed execution permission. Readiness
does not waive per-call scope checks. Do not mutate the Dispatcher yet.

Tests first: transport auth/method/envelope, disabled/unconfirmed/no execution
fallback, trusted configuration requirements and strict Gateway response tests.
Replace test-only file exchange in the real SDK historical cases with this
actual authenticated Client/Adapter path, preserving byte/call/state assertions.
Then run Adapter, Gateway tests/build, root tests/Windows build and the full
SDK matrix. ACK/final delivery repair and rollout remain separate required work.

### Historical HTTP implementation checkpoint

The dedicated authenticated history/readiness routes, explicit trusted Host
configuration and Gateway scope/observation contracts are implemented. Missing
configuration reports unavailable; invalid or changed evidence never falls back
to prompt, Agent resolution or resume. Strict Client validation happens before
send and after response. Existing workbench classification and the reader's
product/native checks remain in force. The option defaults absent/off.

The test-only history file-exchange timer has been removed. All three real SDK
historical cases now traverse the actual Gateway Client, Adapter bearer route,
product-source bridge and raw-history reader. They pass 3/3 (45.11 seconds),
retaining byte, model-call, Agent-count, command state and canonical-message
assertions. Focused Adapter/reader 7/7 and Gateway contract/client 2/2 pass;
Gateway Windows build passes. The complete Adapter suite passes 476/476 without
skips. Final Gateway/root/SDK results follow only after their processes finish.
This makes observation available to a future trusted consumer; it does not
repair ACKs, publish a historical answer or authorize another execution.

Before a product writer consumes this transport, add a separately versioned
binding to the complete product-source digest (including original/command
content hashes) and recheck that digest inside the acknowledgement transaction.
The current observation's IDs and run version alone must not authorize mutation:
command payload/product state can change without that parent version changing.
Keep protocol-1 observations read-only; do not silently grandfather them into a
future repair permission. Reconciliation needs its own idempotent receipt,
ownership/cancellation checks and unchanged source proof. Final-answer recovery
also requires coverage of the entire command set and the original canonical
publication boundary, not just one command's observed answer hash.

Final HTTP checkpoint verification: complete actual local SDK 36/36, zero
failures or skips (492.33 seconds), now using the real authenticated history
transport in all three historical cases. Final Gateway 1173 total, 1167 passed,
six existing skips, zero failures (136.03 seconds); Adapter 476/476 without
skips; root 32/32, public-review regressions 6/6, Gateway/Windows root builds and
BRAIN links pass. All model endpoints are local scripted fixtures. Production
configuration and execution switches are unchanged. Source-digest binding,
atomic ACK repair, complete-command final-answer reconciliation, unknown usage/
fees, real-provider and rolling/deployment acceptance plus the full capability
inventory remain open; this checkpoint establishes read-only transport only.

## Bound historical acceptance and atomic repair sequence

Keep protocol 1 and its endpoint strictly read-only and unchanged. Add protocol
2 at `/v1/sessions/:id/steering-history-v2`, accepting exact `{history,
source_sha256}`. The source digest is SHA-256 of recursively key-sorted JSON of
the complete existing `ordinary_steer_history` product record. The Gateway derives
it from its own transactionally inspected records, never from browser/model text.
The Host compares it before opening raw history and rechecks the full source
after reading. The response echoes protocol 2 and that digest while retaining
`execution_authorized: false`. A missing/mismatched digest refuses; protocol-1
observations cannot be used as bound evidence. Extend strict Gateway Client/DTOs
and real SDK cases to verify both versions without new Agent/model calls.

Then implement `OrdinarySteeringReconciler` for terminal ordinary pending
commands, separate from final-answer publication. Inspect owner/Session/version
and the full source, obtain protocol-2 native acceptance, and re-inspect/hash
inside the same transaction as deterministic product message, applied command,
event and immutable hash-only reconciliation receipt. Changed owner, archived
scope, changed payload/version/status, collisions, foreign/legacy/unknown proof
or cancellation refuse without enqueue/prompt/lease/Goal/cost changes. An
accepted input with unknown provider outcome may have its acceptance recorded;
that never settles fees or authorizes replay. A missing input never authorizes
fallback. Replay the same receipt idempotently, preserve real user cancel/stop
and leave canonical answers/run state unchanged.

Wire a separately opt-in Dispatcher consumer only after the transaction and real
SDK lost-ACK/Host-death tests pass. Keep defaults off; final-answer/all-command
coverage, unknown outcomes/fees, rollout and the complete inventory still apply.

### Bound acceptance implementation checkpoint

Protocol-2 source binding, strict Adapter/Gateway contracts and both-version
real-SDK probes are implemented. `OrdinarySteeringReconciler` snapshots the
terminal ordinary product source, obtains bound acceptance, then rechecks owner,
Session/version and the complete source digest inside the same transaction as
the deterministic user message, command applied state, events and immutable
receipt. Unknown/legacy/foreign evidence, changed payload/source, cancellation,
archive and collisions do not enqueue or repair. Existing applied receipts are
revalidated idempotently without another Host call. No run state, canonical
assistant message, native log/admission, Goal, lease, usage or cost is changed.

The new private receipt table stores only IDs/hashes and source/observation
metadata. Update, replace and direct deletion refuse. Parent run/command or
conversation deletion removes it through existing foreign-key cascades. The
conversation-deletion regression initially exposed an overbroad immutable-delete
guard; the corrected guard preserves owned parent deletion without allowing
standalone receipt deletion. The initial Node direct-TS test also exposed an
unsupported constructor parameter property; explicit fields fix it without
changing runtime semantics.

Six transaction tests pass, including concurrent repair, source mutation during
the Host read, rollback and owner deletion. Dispatcher tests pass 16/16 with
transaction tests. A new actual SDK lost-ACK/Host-death case repairs acceptance
through the original terminal Dispatcher consumer, leaves one interrupted run
and zero canonical answers, then reopens the database and confirms no duplicate
message/receipt or Host query. Native log/admission bytes and model calls stay
unchanged. Four real SDK historical cases pass 4/4 (59.15 seconds).

`GENERAL_AGENT_ORDINARY_STEERING_RECONCILIATION_ENABLED=false` is a separate
opt-in, requiring ordinary steering/recovery and the matching bound-history
Host. Cancelled parents never enter the consumer; unavailable/unknown evidence
stays pending without legacy fallback. The option remains false in examples and
production has not changed. Gateway Windows build, root 32/32, Windows root
build, public regressions 6/6 and Adapter 478/478 pass. Final Gateway and 37-case
SDK results are appended only after their processes finish. Acceptance repair
does not complete all-command canonical answer recovery, unknown money, rollout
or the remaining capability inventory.

Final bound-acceptance verification: complete actual local SDK 37/37, zero
failures or skips (508.16 seconds), including version-1/version-2 continuity,
terminal Dispatcher acceptance repair and reopened-database idempotency. Final
Gateway 1182 total, 1176 passed, six existing skips, zero failures (140.02
seconds); Adapter 478/478, root 32/32, public-review regressions 6/6, Gateway and
Windows root builds plus BRAIN links pass. All providers are local scripted
endpoints. The acceptance consumer and production configuration remain off.
Final-answer/all-command recovery, unknown usage/fees, real-provider evidence,
rolling upgrade/rollback, deployed acceptance and the full inventory remain
required. No existing native reservation, usage or provider outcome is cleared
by recording acceptance.

## Historical final-answer recovery sequence

The existing `RunRepository.appendAssistant` returns the first existing answer;
it cannot replace an obsolete answer after a later accepted supplement. Do not
reuse it as evidence that historical final delivery is correct, and do not
borrow/acquire an execution lease to repair publication.

1. Add `conversations/ordinary-run-history.ts` and a bearer-authenticated internal
   source route. Inspect the exact owner/conversation/run/Session/version in one
   transaction. Require the original complete human input and ordinary scope;
   refuse cancellation, active Worker lease, newer product runs, foreign role/
   task/Goal controls, conflicting Session binding or extra unaccounted human
   messages. Include the complete ordered steering-command set (including its
   states), original input hash, existing canonical answer ID/status/hash,
   candidate status/text/evidence hashes and runtime/expired-lease state hashes.
   Return no user/answer text or execution authority. Zero commands must work.
2. Build a separate raw native completion reader for this full source digest.
   Verify original and every relevant admitted RPC, native pending/claimed
   state, real step/turn closure, settled final assistant output and all-command
   coverage. Use official detached projections/invariants; respect paused/
   blocked/incomplete native Goals and unknown tool outcomes. Logical closers
   cannot certify completion. Recover text, reasoning, artifact references and
   file presentations through the same semantics as the live Runner, without
   resolving an Agent, prompt, maintenance, flush or model/tool dispatch.
3. Add a separately versioned trusted transport/Client contract for the final
   candidate and source/native provenance. Re-read source and native prefix;
   old per-command answer hashes are insufficient. Verify output artifact/file
   ownership/integrity before and inside publication, preserving current
   permission/attachment contracts and user deletion.
4. Implement explicit non-executing historical publication CAS and an immutable
   receipt. Preserve original run/input/Session and one canonical message. Create
   missing output or update the exact older message ID only after complete
   coverage; never append a second answer. Preserve old candidate provenance and
   unknown execution/usage/cost state. Do not infer monetary settlement or clear
   reservations from a completed turn. Cancel, newer user work, changed source,
   foreign scope and unknown outcomes refuse. Enqueue channel delivery only
   through existing authorized bindings and receipts, with no duplicate send.
5. Test actual Host/Worker death after final native persistence but before product
   publication, lost ACK plus final recovery, existing obsolete canonical output,
   two supplements, files/images, cancellation/newer work, source/native mutation,
   failure rollback and reopened-DB retries. Use local scripted providers first;
   real-provider/money, rollout/rollback and full capability acceptance remain.

Start with the read-only full product snapshot and strict route regression.
Source readiness is not completion, publication authority or a new planner.

The full product-source reader is implemented with an authenticated internal
route and exact five-field scope. It hashes the complete ordered command rows,
original input, canonical identity/status/content, candidate bodies and provenance,
conversation/Session binding, runtime binding and expired lease state. Candidate
labels are hashes too; arbitrary source labels must not become a text leak.
Ten targeted regressions pass, covering zero/two commands, lost product messages,
ownership/archive/role/task/Goal restrictions, cancellation/newer work/live or
malformed leases, foreign runtime bindings, duplicate or deleted canonical
answers and workspace/binding mutations without a new run version. No native
completion reader or publication writer is enabled by this source route.

Full source-stage verification: Gateway 1192 tests, 1186 passed, six existing
skips, zero failures (135.20 seconds); root 32/32, public regressions 6/6,
Gateway and Windows root builds, 711-file working-tree public review and BRAIN
links pass. Adapter/Host code is unchanged in this stage; the earlier SDK run
is not final-recovery acceptance. Native completion candidate and publication
CAS remain unimplemented, with production flags unchanged.

## Detached full native completion reader (source stage follow-up)

The new `ordinary-run-completion.js` joins the full product snapshot to original
protocol-2 and all relevant protocol-3 admissions. It requires the exact source
digest before reading raw persistence, no attached Agent/Session, an ordinary
unseeded Session, official detached invariants and official inbox/Goal
projections. Raw step/turn boundaries must close successfully; constructor-added
logical closers are not evidence. Active, paused or blocked Goals, pending input,
foreign/duplicate/missing/late human RPCs, a claim between original admission and
commit, unmatched tools, explicit TOOL_OUTCOME_UNKNOWN and unfinished newer
assistant drafts all refuse. Admission/entry views and source/raw prefixes are
re-read after awaited checks. No execution lease, replay, prompt or flush occurs.

The reader returns scoped native answer/output events plus provenance for the
next trusted transport stage. The shared Gateway `session-output.ts` interpreter
now serves the existing live Runner and the cold characterization: text,
reasoning blocks, structured artifact references and presented file paths retain
their existing semantics. Extraction alone does not validate file ownership or
integrity, publish an answer or settle usage/fees.

Actual pinned rc2 characterization uses three pre-admitted synthetic human RPCs,
four original local scripted model calls and one synthetic output tool. After
runtime context disposal, two detached observations retain the artifact reference,
leave raw persistence unchanged and add no model/tool calls or attached Agent.
The initial fixture assumed three synchronous followups coalesced into one
model call; real DSH performed three original turns. The fixture now measures
and checks actual original calls, with the tool adding one further original
step. This is not a provider latency benchmark or an end-to-end crash/publication
acceptance. Unit tests cover complete output, reasoning/files, malformed scope,
admission/profile/incarnation changes, raw/source races and unknown tails.

No Host endpoint, automatic consumer or production flag is enabled for this new
reader. Full versioned transport, all-command publication CAS, artifact/file
integrity, immutable receipts, crash/reopen tests and provider/deployment/full
capability gates remain required. Previously running SDK regression sources
were unchanged while additional new-reader-only boundary tests were developed.

Verification before publication: Adapter 488/488, shared output regressions
3/3, actual pinned cold-reader characterization 1/1 (no skip), Gateway 1195
cases with 1189 passed/six existing skips/zero failures (140.58 seconds), root
32/32, public regressions 6/6 and Gateway/Windows root builds pass. BRAIN links
and 716-file working-tree review pass. The full existing 37-case actual Host
regression is recorded separately after its original process completes. The
new reader's endpoint and canonical writer remain unimplemented/off; this
characterization does not substitute for their crash/publication acceptance.

The original complete actual Host regression finished: 37/37, zero failures or
skips (510.73 seconds), including completion races, lost ACK, cold claims and
terminal acceptance repair. This validates the live Runner extraction against
existing end-to-end behavior; the new detached reader has its separate actual
rc2 characterization above and is not yet wired to HTTP/publication. Production
and feature switches remain unchanged. Versioned trusted transport, verified
files/artifacts, one-canonical-message CAS and crash/reopen acceptance are next.

## Full historical completion transport and runtime identity correction

The separate absent-by-default `ordinaryRunHistory` trusted kit now composes the
reader with official projections and existing immutable admissions. New bearer
readiness and `/v1/sessions/:id/run-history-completion` routes accept only exact
owner/conversation/run/version metadata plus the complete source digest. They
refuse content/actions/leases, return 503 when disabled and generic 409 for
unconfirmed facts, and never invoke an execution fallback. Gateway
`observeRunCompletion` derives the digest from its caller-held product snapshot,
checks the full pending/applied command order, unique native message IDs,
Session/run/version, settled answer hash and allowed output event sequences.
The existing per-command v1/v2 protocols are unchanged.

Real HTTP integration exposed an incorrect source-only assumption: the Worker
stores a deterministic product runtime cursor in `ga_runtime_bindings`, not the
DSH controller Session from `ga_harness_session_bindings`. The earlier fixture
used the same string for both and missed the distinction. Source validation and
Worker now share the unchanged `runtimeSessionRefForRun` mapping. Actual runtime
identity is accepted; a controller ID substituted as a runtime alias or any
foreign runtime remains refused. This does not migrate bindings, replace a
Session or acquire a lease. The failure and corrected source regression were
observed before the end-to-end test passed.

Four actual pinned Host history cases pass (59.51 seconds), including Host death,
lost ACK, an open raw tail, pre-ready port collision and acceptance repair. The
closed cases now use the real Gateway full-source inspector, Client, bearer
HTTP Adapter, internal product bridge, official raw completion reader and return
validation twice. The acceptance-repair case repeats full completion observation
after the product command becomes applied. Raw logs/admissions, model calls and
canonical/message counts keep their prior invariants; no publication is added.
Twelve focused source/Client checks and three transport/configuration checks
pass. The first attempt at the focused SDK command used the wrong directory and
never ran a test; it is not counted as a feature regression or acceptance.

Full suites are recorded only when their current processes terminate. Scoped
native output events remain private internal data; output ownership/integrity,
publication CAS, immutable final receipts, unknown costs, real providers,
rollout/rollback and deployed/full capability acceptance remain required. No
automatic final-answer consumer or production switch is enabled by this stage.

### Publication implementation constraints confirmed from current code

- `AttachmentResolver.resolveOutputs` checks owner/conversation, registration,
  ready/local state, path root, existence and recorded version/size/hash; it does
  not itself hash current bytes. Historical publication must additionally check
  actual bytes against the immutable recorded version and retain the no-symlink
  boundary used by task outputs. Repeat scoped DB/version checks in the final
  transaction and release temporary artifact leases on every exit. Do not call
  recorded metadata a completed integrity check.
- Keep output extraction separate from final authority. Parse native reasoning,
  text, structured artifact references and presented files with the shared
  interpreter; validate all output artifacts before publishing. A failed file
  check does not downgrade into a successful text-only publication.
- `appendAssistant` returns the first existing message; it is not replacement
  authority. A separate historical CAS must compare the saved canonical row and
  update that exact message ID, or create only when none exists. Never alter old
  candidate provenance or clear `outcome_unknown` by bulk-setting candidates.
- Channel delivery identity includes content as well as the message ID. Merely
  calling `enqueueText` with corrected text can create another effect. The final
  writer must inspect prior message delivery state in its transaction, preserve
  sending/unknown provider outcomes and use a reviewed correction/hold policy;
  repeated receipt repair must not enqueue or resend again. Current work does
  not enable external delivery from historical evidence.
- Re-read complete source and native proof after output preparation, then CAS
  source/version/owner/canonical inside one product transaction. Do not borrow an
  execution lease or use `finalizePublication` to overwrite unknown runtime,
  usage or provider accounting. Test rollback, concurrent repair, reopened DB,
  deleted output/message, cancelled/newer work and conflicting delivery states.

For lost-ACK final recovery, the full proof may contain committed pending
commands whose product user messages are still absent. Final publication must
atomically reconcile those exact deterministic user messages and applied states
alongside the one canonical answer, under the complete source CAS. Keep existing
payload/client-ID collision checks and standard message events. Do not forge
per-command protocol-2 receipts from a full-completion protocol or await another
native call inside a SQLite transaction. The distinct immutable final receipt
must retain the complete accepted command set and its original full proof.
EventStore updates conversation sequence/timestamps on every append: compute
and retain the post-publication source only after all transaction events, then
store the final receipt without a later source-changing event. Reopened retries
must validate that post-state and never rewrite an existing final receipt.

Final transport-stage verification: complete actual pinned Host SDK 37/37,
zero failures or skips (511.32 seconds). The four history cases exercise new
full completion transport alongside unchanged per-command v1/v2; acceptance
repair also repeats the new observation after command application. Gateway
1197 total/1191 passed/six existing skips/zero failures (145.46 seconds),
Adapter 491/491 with the fixed runtime enabled and no skips (9.16 seconds),
root 32/32, public regressions 6/6, Gateway and Windows root builds, BRAIN
links and the 720-file working-tree review pass. The first Adapter run without
the runtime variable had 24 environment skips and is not the final runtime
acceptance. No production flags or deployment changed. Same-message final
publication, verified file integrity, delivery reconciliation, crash/rollback,
real-provider/money and full inventory gates remain required.

## Atomic ordinary final publication core

`OrdinaryFinalPublisher` now consumes the complete bound proof twice, around
output preparation, then compares the complete original product source under
one immediate SQLite transaction. It reconciles exact pending command messages
and applied states, creates a missing canonical answer or updates the exact
existing message ID with a row CAS, links verified output versions and writes a
new provenance-bearing candidate. Earlier candidates, unknown statuses, native
logs, execution leases, run outcome and monetary state are not rewritten.
Reasoning keeps provider exposure; canonical updates use the existing complete
message event/upsert contract. All events precede the post-source digest and
immutable final receipt. A retry verifies receipt/post-state without another
Host call; message deletion retains the receipt so it cannot resurrect output.
Conversation/run deletion keeps the existing private-data cascade.

The dedicated output verifier hashes bounded actual bytes via a read descriptor,
compares size/hash/file identity before and after, and rejects symlinks/junctions
through the entire path. Catalog ownership/readiness/path/version checks still
use the existing resolver before and in the publication transaction. Temporary
artifact retention leases are separate from Worker execution leases and are
released on every normal/refused path. Text and a synthetic PNG are tested
alongside corruption, missing/foreign/late-mutated files and an actual junction.
A failed output check does not publish a text-only fallback. Candidate evidence
retains the repository's string-reference format; detailed provenance is in
hash-only receipt metadata rather than native tool/answer bodies.

Eleven targeted publication regressions pass, including two simultaneous
repairs, reopened DB, rollback after an event failure, cancellation/newer work,
source/second-proof mutation, deletion before/after first recovery, old canonical
identity and untouched unknown candidate/run state. Two actual pinned HTTP Host
crash cases pass (29.32 seconds): native answer durably exists but product output
is missing, and the same case with an obsolete canonical answer. Both recover
through the real Client/Adapter/product source and retain two original model
calls, no cold Agent creation, unchanged raw/admission bytes, one answer and one
receipt; reopened receipt validation never contacts Host.

This core is not wired into a production/automatic consumer. It explicitly
refuses channel-bound or previously externally delivered runs until dedicated
channel correction/hold reconciliation is implemented; this is a remaining
implementation gate, not a replacement for full channel capability. No external
send or new rollout flag is enabled. Existing run outcome is preserved because
publication evidence alone must not erase unknown execution/provider accounting.
Full Goal/business/accounting/deployment gates remain. Before automatic rollout,
add reload/stream ordering acceptance for repaired supplement timestamps and an
updated older canonical message, in addition to the remaining full matrix.

The initial evidence-format regression failed on object-valued evidence refs;
its correction keeps string refs like existing candidates. That default-sandbox
run also lacked junction permission; the final authorized Windows-user focused
run executed the junction check with no skip and passed. Full-suite outcomes
are appended only after their original processes finish.

Additional concurrent acceptance uses two independent Node processes and SQLite
connections, synchronized after both original source snapshots. Both terminate
successfully with one canonical answer, one immutable final receipt, exactly one
reconciliation event and the complete supplemental user set. The focused suite
is now 12/12, including the real junction check with no skip. The first full
Gateway suite (before this extra process case) passed 1208 total/1202 passed/
six existing skips/zero failures (139.61 seconds); a final full suite including
the extra process case is running separately. Implementation/SDK sources remain
unchanged during those verification runs. Root 32/32, public regressions 6/6,
Windows root build and Adapter 491/491 already pass; final SDK and Gateway
outcomes are recorded after their original processes finish.

Final Gateway suite including the independent-process race: 1209 total,
1203 passed, six existing skips, zero failures (140.71 seconds); final Windows
Gateway build passed. Adapter 491/491, root 32/32, public regressions 6/6,
Windows root build, BRAIN links and 725-file working-tree review pass. Only the
original 39-case actual Host SDK process remains in flight; its last case must
terminate before the final SDK acceptance claim or commit.

The original complete actual pinned Host SDK run finished 39/39, zero failures
or skips (578.60 seconds), including both missing-final and obsolete-canonical
publication after hard Host death. Model calls, native/admission bytes, original
run outcome and reopened-receipt no-contact checks pass. This is local scripted
provider evidence, not production or real-provider monetary acceptance. The core
remains unwired to automatic consumption; full channel correction/hold,
reload/stream ordering, run/business/accounting reconciliation, rolling upgrade
and complete deployment/capability acceptance remain required.
