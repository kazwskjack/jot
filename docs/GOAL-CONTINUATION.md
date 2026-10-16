# Ordinary Goal continuation

DSH owns Goal state and automatic rounds. Human pause, resume and stop requests do not grant new tool permissions or certify a task's completion. Ordinary conversation controls remain separate from role and persistent-task Goals.

## Implemented control record

`ConversationGoalControls` stores an explicit resume request and its eventual Host receipt in the existing Gateway SQLite database. It is an execution intent, not a second Goal store. Admission pins the owner, conversation, existing native Session, exact Goal ID/revision, originating run and idempotency key.

A continuation uses the existing `ga_runs`, Coordinator lease, event stream and outbox. Its `input_message_id` is null, and `continuation_of` retains the original source run. The run DTO exposes `goal_control_id`. It does not create another human message. Candidate attribution follows that immutable source lineage instead of fabricating input. The Worker supplies an empty message and no attachments to a distinct `resumeGoal` runner entry. An updated Worker paired with a runner lacking that entry interrupts the control run rather than sending the original prompt again. The null input also prevents a historical Worker input-message join from retrieving the original human prompt. This replay barrier does not prove old consumers can execute the new job; upgrade the complete queue-consumer pool before rollout.

The dispatch boundary records the official follower's opening cursor, a Host-generated per-observer identity and the exact Worker lease generation. Begin, applied and not-called rejection must carry that same observer identity. A delayed request from an earlier connection on the same lease cannot reject or apply a replacement connection's dispatch. Only the first `begin` returns `acquired: true`. A repeated `begin` does **not** authorize another mutation. An unconfirmed dispatch fences new attempts even after the product run ends. Reopening the database preserves the original request and receipt. Existing databases gain a nullable observer column and an immutable post-dispatch guard; historical uncertain/applied records retain null instead of being retroactively assigned to a new observer. The migration does not authorize replay.

A confirmed pre-native refusal has an immutable `{rejected: true, mutation: "not_called", reason_code}` receipt. Only the original trusted live Host attempt, before invoking native resume, may send that attestation through the authenticated run/Session/lease endpoint. It can close a queued intent or a dispatch whose begin acknowledgement was lost. Once native resume has been invoked, a thrown error, failed flush or unavailable applied acknowledgement stays uncertain; it must not be relabelled "not called". Worker interruption and the UI retain a fixed refusal reason rather than a raw transport error. Retrying the original accepted request still returns its original 202; a new explicit intent is distinct and remains subject to normal admission.

An applied receipt must contain the same Goal ID, the next revision and native active/armed state. Identity, dispatch metadata and final receipts cannot be overwritten. A stale lease, changed Session, archived conversation, cancellation, role/task scope or mismatched source run invalidates execution. The Worker cannot become ready, publish projections, attach generated artifacts or publish a final answer before the applied receipt exists.

## Observed Host and original Runner

The opt-in Host backend subscribes to official follow and reads its opening snapshot before resolving an Agent. The locked SDK promotes a prepared ordinary Session when its iterator advances beyond that snapshot. The adapter therefore parks the subscribed iterator at the opening boundary until cold preflight passes, the exact Agent has been resolved and native maintenance has begun. Official subscriptions buffer the intervening events. Disconnect/disposal releases this wait without advancing native follow; observing or refusing pending input cannot trigger promotion. One exact control, run, Session and lease generation owns that live observer. The internal Gateway endpoint uses the existing service credential and rejects owner overrides, foreign run/Session identities and stale leases.

After validating the ordinary preset, empty inbox and the official balanced logical history, the Host uses the official resolver and `runMaintenance`. A persisted interrupted tail may already appear balanced in that logical view; this is different from a still-open attached turn. It begins the original dispatch once, resumes through native Goal CAS, flushes native persistence and commits the applied control receipt before releasing automatic rounds. Lost HTTP acknowledgements reuse the same process-local operation promise. A lost persisted-receipt acknowledgement can reconcile that original receipt without repeating native resume. New Host processes or followers do not turn an old receipt into activation authority.

Original step, tool and LLM middleware recheck the live observer, original lease and current native Goal identity. An old receipt cannot authorize a replacement Goal in the same Session; a closing answer for the same completed Goal remains permitted. They preserve the existing native execution/permission chain and provider chunks. The LLM waterfall returns an AsyncIterable synchronously, as required by the SDK. Disconnect disarms future continuation and cancels its controlled in-flight turn; disposal also aborts the original follow. Durable Goal phase is not rewritten to pretend completion.

`OfficialSessionRunner.resumeGoal` now follows first, sends the bounded human control and observes subsequent native events on the same iterator. It never creates an Agent before observation or sends a new human prompt. Invalid refs and malformed cursors are refused before activation. Normal message handling keeps its existing path.

The Host option `conversationGoalResume: true` requires the existing internal Gateway token. It is off by default, and the standard profile does not enable it. The authenticated public resume route and ordinary-chat UI now use this admission when the separate Gateway rollout option is enabled.

## Public admission and display

`GET /v1/conversations/{id}/goal/resume-readiness` checks the original queue, existing Session and configured Host capability without activating an Agent. It returns enabled/ready flags plus a fixed reason. A busy product run, unconfirmed dispatch, missing Session or unavailable Host cannot admit a new continuation. A running product status alone is never proof of an attached native follower.

`POST /v1/conversations/{id}/goal` with `action: "resume"` retains the exact native ID/revision and original idempotency key. Admission creates the intent, original queued run/outbox/event and **202 acceptance receipt** in the existing atomic transaction. Its body is `{accepted, control_id, run_id, conversation_id}`; it is not a Goal state or completion receipt. A response lost after commit recovers the same receipt even when the Host is offline. A typed reservation interrupted before admission can retry its original request without duplicating a run. Conflicting payloads cannot reuse a key.

The ordinary Goal card follows that control run separately from native Goal state. It shows acceptance while native restoration is pending, continues polling even while the product run is queued, and only shows completion from a validated native Goal view. Unknown replies retain the exact original request for explicit retry across reloads and page-renderer crashes. The browser stores only the original action, Goal ID/revision and idempotency key, under an authenticated opaque owner scope and conversation. It never stores the objective, messages, credentials or native phase in this journal. Role and persistent-task conversations keep their existing scoped paths.

Gateway `GENERAL_AGENT_CONVERSATION_GOAL_RESUME_ENABLED` defaults to false. Enable it only after the full consumer pool is upgraded and the recovery/deployment gates below pass, alongside the trusted Host `conversationGoalResume: true` option. Neither switch is enabled in the standard profile by these changes. The readiness endpoint reports configured capability and current admission facts; it is not an audit of every historical Worker binary or a guarantee that a particular cold history is recoverable.

## Browser command recovery

Before a control POST, the exact command must commit in IndexedDB with
`durability: 'strict'`. The UI waits for transaction completion, not only a
successful individual put or a same-page read-back. localStorage alone lost an
unconfirmed command in the real whole-browser crash probe; it is now only a
legacy migration source. Missing authenticated scope, unavailable strict storage
or corrupt records prevents a new control POST. Commands still contain only the
original action, Goal ID/revision and idempotency key plus local pending/ack and
migration metadata; no objective, message, credential or native phase is stored.

Fresh authenticated capabilities are checked before sending and before accepting
the response. Account changes cannot redirect an original command into another
owner namespace. Each command has a separate owner/conversation key; IndexedDB
read/write transactions serialize same-key checks across tabs. Reopening restores
pending metadata but sends nothing automatically. Explicit retry keeps the
original Goal reference and key, never a regenerated request based on current
Goal state. Known native preflight/revision refusals resolve their command;
authentication, not-found, timeout, unknown conflict and transport errors retain it.

Pause receipts must identify the same Goal at the next revision in paused/disarmed
state; stop must return null; resume validates its separate original-run 202.
Acknowledgement commits durably before pending UI state is cleared. Up to twenty
ordinary acknowledged records per conversation are retained when pruning succeeds;
unknown commands never expire automatically. Imported legacy acknowledgements
retain a durable migration tombstone until local acknowledgement succeeds, so a
failed legacy update cannot resurrect an uncertain request. Failed pruning may
retain additional safe tombstones. No local marker certifies native completion.

```sh
npm run build
npm run test:goal-ui
npm run test:goal-ui:browser-crash
```

Both built-browser modes check legacy migration, concurrent commands, owner
isolation, strict-commit refusal, bounded acknowledgements, unknown-command
retention and corrupt-record refusal against real IndexedDB. They commit a
synthetic pause, lose its reply, reload and check the same key. They then commit a
resume 202 and lose its reply. The default mode terminates the page renderer and
opens another page. The browser-crash mode starts its own browser with a fresh
workspace-local profile, forcibly terminates only that owned process tree,
confirms process exit and CDP disconnection, then starts a new browser with the
same profile. It never exports/reinjects storage to simulate recovery and never
selects or terminates a user's browser. Explicit retry recovers the same original
control/run; 202 is still not native Goal completion, and no extra user message
is generated.

These probes use synthetic local HTTP responses, not a real provider or deployed
conversation. They do not prove OS/power-loss behavior, storage eviction or private
browsing teardown. Clearing site data can remove the journal and must not be
interpreted as confirmed failure or permission to reconstruct an old request.
The first CDP `Browser.crash` attempt hung the automation transport after the
browser exited; the final owned-process probe uses independent process handles
and bounded cleanup rather than treating an observation timeout as process exit.

## Remaining acceptance

1. Verify every consumer of the original run queue has the updated continuation path before enabling admission. A historical consumer may not make progress on message-free continuation records, even though the old input join cannot replay the original message.
2. Complete process-exit and reply-loss reconciliation at all dispatch/flush/publication boundaries. Pending/claimed input still requires supported recovery and is refused before activation. Persisted interrupted tails with an empty pending inbox use the official logical-read and durable-resume repair described below; unsupported still-open attached turns remain refused.
3. Keep unknown mutations fenced. A new lease cannot replay an old dispatch. Human pause/stop remain authoritative, and a current native state that happens to match is not proof of a prior operation receipt.
4. Separately verify a synthetic deployed conversation and deployment rollback. Local model fixtures do not prove real-provider quality, production usage accounting or comprehensive crash recovery.

The installed SDK's normal follow request has no `afterSeq` field. Recovery must use supported history/follow semantics; adding an undocumented request property is not a recovery implementation.

## Verification

```sh
cd packages/gateway
node --test test/routes/conversation-goal-resume.test.mjs test/harness/conversation-goal-controls.test.mjs test/harness/worker.test.mjs
cd ../..
npm run build
npm run test:goal-ui
node --test packages/session-adapter/test/conversation-goal-run-host.test.mjs
node --test --test-concurrency=1 packages/dsh-host/test/observed-goal.test.mjs
```

The first tests use isolated SQLite files and an injected runner. The last test requires `JOT_DSH_RUNTIME_MODULES` pointing to the installed locked SDK package directory; without it, the native cases are explicitly skipped. It starts a real official Host, real Gateway and local synthetic HTTP model, restarts the Host, then checks both direct observed resume and public authenticated 202 admission through original Worker publication. The public acceptance can be replayed after the Host has stopped. The normal native Goal cases finish after three scripted model requests, the original human prompt is absent from provider inputs, only one assistant answer is published, and another Host restart preserves completion without inference. These are local SDK/integration results, not production or real-provider acceptance.


### Failure evidence and remaining crash matrix

The installed-SDK probe also covers a persisted pending inbox and real isolated
Host termination at three verified boundaries: native Goal change emitted before the adapter flush returns, native persistence completed but
Gateway applied receipt not committed, and applied receipt committed before its
HTTP acknowledgement. Pending input must keep zero Agent creations and zero
model calls. Terminated cases keep zero model calls, preserve native phase across
restart without rearming it, recover the original public acceptance, and never
publish an assistant answer. The unconfirmed dispatch refuses replacement keys.
A new Host cannot reuse an old control as activation authority.

Host unit cases additionally inject lost begin replies, native-call failure after
an append, failed native flush and unconfirmed applied acknowledgement. Only
failures before invoking native resume can produce a not-called receipt. A native
call that appended then threw is disarmed and stays uncertain; the API's thrown
error is not proof that its event never committed.

These cases do not exhaust process exits inside native CAS/flush, provider usage
settlement, publication transactions or pending/claimed-input recovery. They are tracked separately from the three actual process-termination
boundaries above. Neither test scaffolding nor a safe refusal substitutes for
those remaining implementation and deployed acceptance requirements.

| Interruption boundary | Required evidence and behavior | Current evidence |
| --- | --- | --- |
| Public reservation before atomic admission | Same original key may recover; no duplicate queued job or native activation | Gateway typed-reservation and lost-reply route tests |
| Public 202 committed, before native work | Recover the same control/run receipt even if Host is offline | Public API tests and installed-SDK public Worker probe |
| Opening snapshot, before maintenance | Subscriptions buffer events; no post-snapshot promotion or pending-input activation | Iterator unit test and installed-SDK zero-Agent/zero-model refusal |
| Begin response lost, native call not invoked | Only the same live observer can attest not-called; a replacement observer cannot close its dispatch | Host injected fault, immutable observer journal and internal-route tests |
| Native invocation appends then throws | Disarm controlled execution; retain uncertainty; never claim not-called | Host injected native-call failure test |
| Native Goal change emitted, before adapter flush | Do not infer not-called from an unchanged cold projection; retain the original dispatch, disarm on restart and refuse replacement keys | Actual isolated Host termination at the synchronous native notification; original paused revision survived in this probe, dispatch stayed unknown, zero inference/publication |
| Native flush completed, before applied commit | Restart disarmed; zero inference/publication; keep unknown dispatch fenced | Actual isolated Host termination probe |
| Applied commit, before its acknowledgement | Retain the original receipt; restart disarmed; never infer execution completion from acceptance | Actual isolated Host termination probe |
| Inside native CAS/flush, provider usage settlement, final publication commit | Reconcile exact native events, original cost holds and one canonical output without replay | Additional process-exit acceptance remains required |
| Browser exits before control acknowledgement | Restore the exact original owner-scoped command/key, never infer its receipt from current Goal state | Built-browser reload, renderer crash and strict-commit journal recovery, including lost committed pause and 202 resume receipts; owned whole-browser process-tree termination and restart are verified; OS/power-loss behavior is not |
| Persisted interrupted tail, no pending inbox input | Cold read stays read-only; official resume commits conservative closers and continues through the original Worker without replay | Real locked-SDK cases for open turn, started tool and unstarted tool, including another cold restart |
| Parked/claimed input or still-open attached turn | Recover original input through its proper execution lineage without dropping or borrowing it for a new Goal run | Refusal is verified; full supported recovery remains incomplete |


## Official interrupted-tail recovery

The locked SDK already provides this path. Its Session Query `readColdSessionLog`
reads a stored log and adds `interruptedTurnClosers` to the **logical in-memory**
event array without acquiring write ownership or changing storage. The Session
Controller's cold `inspect` therefore sees balanced history. Agent Loop
`resumeWith` later opens the original write handle, appends the SDK's conservative
closers, then publishes the original Agent. There is no Jot repair algorithm or
manual history rewrite between these two stages.

For an assistant tool request with a recorded `tool/call` and no result, the
SDK supplies `TOOL_OUTCOME_UNKNOWN` and explicit guidance against blind side-effect
retries. A request with no call-start record gets `TOOL_NOT_STARTED`. Existing
committed results stay intact. Original planning, tool permissions, accounting,
lease/observer checks and the new native Goal CAS remain separate requirements.
A recovery result never proves that an external side effect did or did not occur.

The real Host regression seeds three valid interrupted persisted tails: an open
turn, a started write request without a result, and a tool request without a start
record. It compares native compressed-log hashes before/after cold reads, checks
zero Agent creation and zero inference for those reads, then enters through public
202 admission and the original Worker. Restored Agent history contains the proper
native closer/code; the model receives conservative recovery text, the original
call-start count does not increase, and the synthetic write target stays absent.
Three scripted requests complete the Goal and one original assistant answer is
published without replaying the source user input. Another Host restart can read
completion without inference. These are valid seeded-history tests, **not**
additional kills inside a real in-flight tool or proof of real-provider judgment.

This corrects the previous broad statement that all interrupted history was an
unimplemented recovery path. It does not authorize stealing pending human input
from another queued run, restoring claimed input under the wrong lineage, fixing
arbitrary already-closed inconsistent logs, or enabling production continuation.
The SDK itself documents that failed-step recovery does not rewrite unanswered
calls in already-closed historical turns. Pending-input recovery and the rest of
the process/crash and rollout matrix remain in scope.


## Observer revocation preserves other inputs

The official Agent `cancel` defaults to clearing its durable inbox. A Goal
observer losing its connection or lease owns cancellation of its controlled
in-flight work; it does not own cancellation of later human input. The adapter
therefore disarms only the same Goal identity and uses the official
`cancel({kind: 'parent'}, {keepInbox: true})` option. Observer/lease loss is an owning-execution cancellation, not evidence that the user pressed stop. It neither removes nor reinserts pending
messages and does not send another prompt. A replacement Goal is never cancelled
by an old observer.

This cancellation also applies when the same Goal has moved to paused, blocked
or complete while its original model/closing-answer request is still running.
Those phases are not proof that an in-flight request has stopped. With a live
observer, same-Goal completion still permits its original closing answer; loss
of that observer revokes its execution. No native durable phase is rewritten.

A unit regression models the SDK's default inbox-clearing behavior and checks
both later queued and next-step inputs across all four native phases. The real
locked Host probe admits an original control, keeps its first local model HTTP
request in flight, parks two distinct synthetic user inputs, then disconnects
the observer. The native driver reaches idle with both IDs retained. The probe
explicitly awaits native persistence flush and restarts the Host; a cold
projection still contains both inputs, creates no Agent and makes no second
model request. No assistant answer is published for the cancelled request.

That probe proves retention and flush/restart behavior, not recovery under an
arbitrary power failure before input persistence, production rollout, or actual
delivery of the synthetic inputs through separate Gateway runs. Re-admitting
pending/claimed input through its original product run and permission/usage
lineage remains a separate requirement. A new Goal run must not silently consume
it simply because cancellation now preserves it.


## Live claimed-input preservation

`keepInbox` only protects messages still queued. The native loop claims its next
batch before entering the pre-step waterfall. If the Goal observer loses its
lease/connection inside that waterfall, rejecting the step previously stranded
the just-claimed human inputs outside the inbox and outside committed conversation
messages. They had not been sent to a model, but no longer appeared as pending.

The observer now retains only its original live pre-step payload while that
waterfall runs. Before its own revocation cancellation, it synchronously checks
the same live Agent and Goal, skips already committed user-message IDs, and puts
original human inputs back at `next-step` in original batch order. This follows
the official Goal driver's `restoreOtherClaimed` convention for unentered step
context. Original IDs, content and RPC/source identity remain intact. Generated
Goal-round prompts and downstream-generated context are not reinserted. There is
no send, new prompt, model call or wake operation. Payload references are released
when the waterfall returns; this is not a second input scheduler or Goal store.

An already-aborted native step is not restored, so explicit user cancellation
cannot be undone. Preservation is synchronous and happens before the observer's
own cancel, allowing a later explicit cancellation to discard it normally.
Identical already-pending input is not duplicated. Conflicting content, duplicate
identities or unavailable original history is reported as
`goal_input_recovery_unconfirmed`; cancellation still proceeds, and the adapter
does not overwrite another message or claim successful preservation.

The actual Host probe parks one synthetic human input during native Goal resume,
lets the native loop claim it, then revokes the original Coordinator lease at the
first applied pre-step guard. The input is claimed exactly once, no model request
or assistant publication occurs, and the original input ID remains pending at
idle. After an explicit native flush and another Host restart, a cold projection
still contains it without creating an Agent or making a model request. The
original native applied receipt is not relabelled as a not-called rejection.
Unit tests separately cover pre/post-waterfall rejection, prior/later explicit
cancellation, committed IDs, identical pending input and conflicting content.

This is an in-process preservation window, not reconstruction after an arbitrary
Host crash or authorization to consume old pending inputs under a new run. Cold
pending/claimed-input recovery still needs its original run/RPC, owner, lease,
composition and accounting evidence. A raw claim record alone is not replay
permission, and a safe refusal is not complete recovery acceptance.


### Native change before flush

The `crash-native-change` fixture listens to the installed SDK's synchronous
`goal/changed` notification for resume. The official implementation appends the
Goal event and updates its in-memory activation before emitting that notification.
Only the isolated test plugin pauses there; the parent owns its spawned Host
handle and terminates that process after reading the boundary marker. This keeps
the adapter from reaching its explicit persistence flush or applied receipt.
The bounded pause throws if the parent fails to terminate it, so a timeout is
never accepted as process-death evidence.

In the verified local run, cold restart recovered the original paused Goal
revision, while the Gateway correctly kept the exact dispatch uncertain. No model
request or assistant publication occurred. The original public acceptance still
resolved to its original run; stale control execution and a replacement key were
refused. An unchanged persisted Goal does not prove that native resume was never
invoked and must not manufacture a not-called receipt.

This is one real process boundary after the in-memory native commit and before
the adapter's flush. It does not prove all native CAS branches, partial storage
writes, OS/power loss, provider settlement or final publication reconciliation.
The fault plugin is test-only; production code and default switches are unchanged.


## Original human input binding

The internal `POST /internal/v1/workbench/ordinary-input-binding` endpoint reads
an original ordinary run's lineage under its current Coordinator lease. It uses
the existing service credential and accepts only `run_id`, `session_ref` and
`execution_lease`. Owner identity comes from the database, never from the caller.
A single transaction checks the running original run, its original user message,
conversation ownership/archive status, current native Session binding and lease.
Workbench roles/bound runs and message-free Goal control runs are rejected.

The read-only receipt contains the original product message ID, original run ID
as expected native `source.rpcId`, owner/conversation/Session, exact lease, and a
SHA-256 of the stored product content bytes. It never returns prompt content or
changes records. Product message IDs and native message IDs are distinct; the
stored-content hash does not assert equality to transformed native attachments.
`execution_authorized: false` is deliberate: this snapshot is not a wake token,
model cost reservation, tool approval or proof that native input remains pending.
An expired receipt must be rechecked against original authority before mutation.

This is connected identity infrastructure for ordinary pending/claimed-input
recovery. The existing Host and Runner do not yet invoke it to consume an inbox.
Restoring native claims, checking the original preset/composition, observing the
same run, preserving cumulative usage and admitting supported driver execution
remain required. No private wake method or fabricated prompt is used, and no
Goal resume switch is enabled by this endpoint.

Route tests cover an exact unchanged database receipt, content omission, service
authentication, caller-owner rejection, wrong Session/lease, archive and cancelled
states, corrupt message lineage, workbench scope, and message-free continuation.


## Optional native pending-input wake compatibility

The locked upstream rc.2 Controller treats an existing prompt RPC as accepted
without waking pending input. Its driver's wake method is private. Jot therefore
provides an explicit optional compatibility delta, not an upstream API or another
scheduler: `patchDshPendingInputSource`, prepared only in a new isolated package.
The exact upstream package bytes, setup-hook delta, declarations, secondary files
and license are still verified. Modified, partial or different SDKs are rejected.
The normal preparation command and installed runtime are unchanged by default.

```sh
node packages/session-adapter/scripts/prepare-dsh-pre-setup.mjs \
  /absolute/private/source/dsh-agent-loop \
  /absolute/private/new/dsh-agent-loop --pending-input-wake
```

The optional Agent capability `jotPendingInputProtocol: 1` offers
`jotResumePending({requestId, messageIds, seq})` only inside original native
maintenance. It requires the exact unchanged Session sequence and complete ordered
pending IDs; every pending input must be an original human message with that
request RPC. Empty, duplicate, foreign, generated Goal, changed, already-waking,
idle/running or aborted calls are refused. It latches the original native driver;
it never inserts/removes input, creates a prompt, changes Goal state or adds a
user message. Native maintenance then decides whether to start: a user cancellation
clears the pending latch/input and prevents inference.

An installed-SDK test prepares the optional package and uses a synthetic local
model. It confirms no message or inbox append during the latch, one commit of
the existing original user message and one model request. A second Agent cancelled
inside maintenance makes no additional model request and commits no user message.
The primitive tests also verify partial-package refusal and source/version drift.
These are actual native driver results for an attached pending inbox, not a cold
process-crash recovery or full Gateway/Host/Runner deployment acceptance.

The default HTTP Host does not yet invoke this capability. Before enabling it,
connect the original product binding, cold claim restoration, audited preset and
composition, an original-run observer and repeated lease/cancellation checks;
retain cumulative model usage and canonical final publication. This optional
native primitive grants none of those authorities and must not be presented as
ordinary recovery being fully enabled. Existing Goal switches remain off.


### Pending input across real process death

The installed-SDK fixture now also uses three separate processes. The first
quietly admits one synthetic original input with its original RPC, explicitly
flushes and verifies the durable native prefix, then reports its exact identity.
The parent owns that spawned process and force-terminates it only after the
receipt, waiting for its actual exit. No framework disposal substitutes for the
crash, and no timeout is treated as proof of termination.

A fresh process resumes the same persisted Session and confirms the exact input
is still pending with zero automatic model calls. It latches that original input
inside native maintenance. The execute case commits exactly one original human
message and makes one scripted local model request, retaining its original ID and
RPC. The cancel case invokes native user cancellation before leaving maintenance
and commits no human message or model request. Neither case sends a new prompt.

A third fresh process cold-reads the resulting native log and reconstructs its
inbox with a detached official Session projection. Both queues are empty and no
Agent or model is created. Hashes of all regular native store files remain
identical across this cold inspection. Each spawned fixture process is confirmed
terminal before its isolated test directory is removed.

This proves the optional primitive across this flushed-pending-input process
boundary. It does not cover an input already claimed before the crash, unflushed
power loss, the default HTTP Controller, original Gateway/Worker execution or
production permissions, composition and cumulative usage. Those integration and
acceptance requirements remain open; the default runtime remains unchanged.


## Original input resume preflight

The exported `prepareOrdinaryInputResume` connects the internal product binding
receipt to a cold native Session and its exact existing human RPC. A trusted
caller must provide a live observer assertion and an audited composition check.
This preparer does not create an observer or grant execution by accepting a
caller-supplied boolean. The future HTTP Host must own the real parked stream.

Before resolving an Agent it checks the original product receipt, ordinary preset,
complete pending queue, human IDs/RPC, native history sequence and balanced turns.
Already entered inputs, foreign requests, empty queues requiring claim recovery,
paused/blocked Goals and unsupported composition are refused. Cold projections
and history are cloned and frozen before asynchronous composition checks; sharing
a mutable projection with a later inbox mutation cannot replace verified input.
The native Agent must remain the original idle registered instance, with the
optional compatibility capability and matching pending content/targets.

The trusted `verifyComposition` callback runs at `cold` and `bound` phases and
must return `{verified: true, fingerprint}` with the same reviewed fingerprint.
It must verify historical provenance, actual preset/model/permissions/attachments
and current mounted composition; returning a preset name alone is insufficient.
There is intentionally no permissive default callback. Product authority is read
again around preparation. The returned `check()` validates the unchanged local
snapshot; asynchronous `recheck()` also reads current original lease/lineage and
rechecks composition. Neither check is an enduring capability or tool approval.

The result exposes the original Agent and exact native wake request, plus the
unchanged `execution_authorized: false` identity receipt. It never calls native
maintenance, wake, prompt or a model. The HTTP Host/Runner still needs to own the
observer, invoke checks inside native maintenance, admit execution and guard
subsequent steps/tools/models while preserving original usage/publication.
Claim restoration and complete process/accounting/deployment acceptance remain
separate requirements. The helper is packaged/exported for that integration;
it is not wired to default HTTP routes or enabled by a preset change.


### Revoking only the observer's queued wake

A native maintenance boundary needs separate wake revocation. The installed SDK
retains a previously latched wake when `cancel({kind: 'parent'}, {keepInbox: true})`
aborts maintenance; leaving maintenance can still start the original driver.
A real SDK regression reproduced a user-message commit despite the expected stop.
Keeping pending input and revoking a queued wake are separate operations.

The optional package now also declares `jotPendingWakeRevocationProtocol: 1` and
`jotRevokePendingWake(wakeToken)`. Each successful `jotResumePending` produces a
fresh process-local Symbol token. It is a non-enumerable, readonly property of
the local result and is omitted from JSON; the public metadata receipt is not
revocation authority. A trusted Host must retain that local token and revoke
its wake before cancelling maintenance with the parent cause and keepInbox.
Revocation clears only that owned native latch; it preserves all input.

The token is specific to one maintenance attempt. Even another attempt with the
same original message IDs/RPC and unchanged Session sequence gets a different
token. A subsequent independent native wake invalidates the earlier token rather
than allowing an old observer to cancel it. Forged, stale, repeated and already
running/idle revocations return false without cancelling another execution.
There is no persisted token, new planner or reusable permission grant.

Installed-SDK regressions cover retained input with zero inference after owned
wake revocation, old-token refusal in a later identical maintenance attempt,
and preservation of a subsequent independently authorized native wake. Ordinary
resume preflight now requires both capability protocols and both methods.
The preparer still does not execute or revoke by itself. HTTP Host/Runner wiring,
original cumulative usage and deployed acceptance remain incomplete; no default
runtime is modified by these tests or the optional preparation transform.


## Optional original-input HTTP observer Host

The adapter can opt into `ordinaryInputRecovery: {verifyComposition}` in trusted
Host configuration. It requires the existing internal service credential and an
actual audit callback; absent configuration leaves recovery unavailable. The new
`createOrdinaryInputRunHost` is packaged/exported. It reuses the existing native
Controller, original product binding and Coordinator lease, rather than creating
a prompt, Goal or scheduler.

An authenticated follow request carries `ordinary_input: {run_id, execution_lease}`.
The Host checks original binding, subscribes to native follow and parks its iterator
at the first snapshot. It cannot advance native observation or resolve an Agent
before the audited preflight. The same live observer then owns
`POST /v1/sessions/<session>/input-resume` with the same `ordinary_input` body.
Goal controls and ordinary recovery cannot be combined in one follow request.
Malformed execution metadata is rejected before native stream creation.

Native maintenance rechecks original lineage/composition and unchanged input,
then releases follow only after admission to that maintenance boundary. Another
check precedes the native existing-input latch. The Host retains the local wake
Symbol; its HTTP result contains only original run/Session/product message and
native input IDs plus `accepted: true`. It is not a completion certificate or
a durable replay receipt. A duplicate call on that same live observer shares the
same attempt promise; a new Host does not reconstruct local wake authority.

The original Agent's pre-step, tool and model hooks recheck original lease,
identity and composition. Disconnect revokes its exact pending wake before
parent cancellation with keepInbox. A known live pre-step preserves original
unentered human claims before that cancellation. Guards remain installed while
maintenance is unwinding; a native latch that throws or returns an invalid result
cannot admit inference. The Host rechecks observer liveness before acknowledging
maintenance. Native idle releases execution ownership. A later foreign human
input after idle closes/detaches the old observer and delegates to the new task;
the old Host does not reject or cancel it.

The new Host route/lifecycle tests are isolated fixtures. Installed-SDK tests
separately prove the native wake/revoke primitives; this does not yet prove this
complete Host with the real Controller/profile, original Worker accounting and
canonical publication. Runner selection is not wired yet. Cold claimed recovery,
steering ownership mapping, durable failure reconciliation, real-provider and
production acceptance remain open. No standard profile enables this option and
ordinary Goal switches remain off.


### Real Controller HTTP recovery evidence

`packages/dsh-host/test/ordinary-input.test.mjs` now runs the optional Host with
an installed real Controller, real ordinary preset, isolated compatibility loop,
authenticated HTTP/NDJSON transport and original Gateway/Coordinator records.
A test-only wrapper quietly seeds one synthetic pending human input under the
original product run RPC and explicitly flushes it. The parent kills its owned
Host process, replaces the expired original lease with generation 2 on that same
run, then restarts. This seed is not evidence of the production prompt-admission
path; the subsequent Controller/Host recovery path is real.

Three cases pass: execute consumes that original native input once with one
local scripted model request; lease replacement after the opening snapshot
refuses recovery before Agent creation and retains the original pending input;
disconnect during the held model request records native parent cancellation and
flushes the resulting idle state. The opening snapshot itself creates no Agent
and calls no model. Another Host restart cold-reads the expected pending queue,
creates no Agent, and refuses the vanished original observer without inference.
Repeated requests on the original live observer reuse its acknowledgement.

The event assertions distinguish explicit human `source.kind: user` from DSH's
runtime-context and skill-catalog messages, even when those use user-role events.
Generated context is neither a second human request nor a duplicate answer.
The Gateway retains one original human product message and zero assistant
publications in these manual Host tests: canonical Worker publication and usage
reconciliation are still separate, uncompleted integration requirements.

The test audit callback is deliberately synthetic; it does not certify historical
production composition, approval behavior, real-provider quality or costs. In this
Loader fixture, changing only the existing agent-loop entry's name left the old
Agent implementation active. The passing isolated overlay explicitly disables
that entry and inserts the separately prepared compatibility plugin. It asserts
both actual native capability protocols before crashing the seed process. No
installed or production SDK is modified.

Run the three cases with the existing locked `JOT_DSH_RUNTIME_MODULES` setting:

```sh
node --test --test-concurrency=1 packages/dsh-host/test/ordinary-input.test.mjs
```

Without the SDK setting the cases are explicitly skipped, not counted as native
acceptance. Runner/Worker selection, original accounting/final publication,
claimed input, steering scope, all-boundary recovery and deployed acceptance
remain required. Both existing Goal switches and standard recovery configuration
remain disabled.


## Opt-in original-run Runner and Worker recovery

`GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED=false` is the Worker default.
When explicitly enabled, a reclaimed ordinary run (lease generation greater
than one, outside workbench and Goal-control execution) uses `recoverInput`.
It reads the existing owner-bound native Session from the original database;
it never allocates a replacement Session. Missing original binding or a mixed
Worker/Runner without recovery support interrupts the original run with
`ORIGINAL_INPUT_RECOVERY_UNAVAILABLE`, without normal prompt fallback.

The transport adds only exact original run/lease metadata under `ordinary_input`
on follow and input-resume. Runner opens and reads the native snapshot first,
then requests recovery and validates the exact original run, Session, product
message and unique native input IDs. It does not call create, prompt, file
upload, input attachment resolution or runtime context staging. Goal and ordinary
execution authority cannot be mixed. Invalid acknowledgements stop observation
before accepting output as belonging to the original request.

Subsequent streaming, native Goal observation, artifacts, candidates and final
publication reuse the existing Runner and Coordinator path with the same run ID.
The Worker rechecks the original owner/Session/message/content hash and live
lease before readiness, projections and canonical publication, including inside
the final publication transaction. A changed source under the same message ID
cannot be published against the earlier input. A replaced lease cannot publish
from the obsolete Worker. This does not grant additional tool permission or
change reasoning settings.

The real installed-Controller fixture also exercises this Worker branch: after
hard Host death it reclaims that original run, makes one scripted model request,
keeps one original human input, and publishes one canonical answer to that same
product run. A second poll finds no task; another Host restart does not create
an Agent or issue another model request. The original native assistant event
retains its one provider-reported usage receipt. This is native usage continuity,
not monetary reconciliation or proof of all historical unknown spends.

The SDK seed and composition audit remain synthetic. Production prompt-admission
provenance, historical composition/attachment validation, cold claimed recovery,
steering ownership, already-entered or unknown native outcomes, cost settlement,
all consumer upgrades and deployed acceptance are still required before enabling
the Worker flag and optional Host configuration. There is no automatic fallback
that fabricates a continuation message for an unconfirmed native attempt.


## Pending original input with a persisted Goal

The installed rc.2 Goal service resets process-local activation to `disarmed`
on Agent creation. Its round driver only schedules automatic rounds when the
Goal is both `active` and `armed`. Waking the existing human inbox is not an
independent human-authorized Goal resume edge. Ordinary-input recovery must
therefore leave the existing Goal identity, revision, phase and round counter
unchanged; it must not create a Goal, call resume, or fabricate a Goal-round prompt.

The real Controller/HTTP/Worker fixture now covers pending original input beside
persisted `active` and `complete` Goals: one original human input, one model
request and one canonical product answer, with no native Goal-source message.
Both Goal views remain disarmed and unchanged before and after recovery and
another cold Host restart. Persisted `paused` and `blocked` Goals are refused
before Agent creation or inference; their original inbox input survives restart.
These are isolated SDK and scripted-provider checks, not deployed acceptance.

This establishes coexistence without implicit rearming. It does not establish
a combined workflow for recovering pending input and then explicitly resuming an
active Goal, nor recovery after input claim or model dispatch. Those remain
separate original-run authority, cancellation and accounting acceptance gates.


The expanded suite also exposed one intermittent timeout in the existing manual
`execute` case: the native assistant usage and completed `turn/end` were present,
but the fixture's idle-flush receipt did not arrive within its deadline. An
isolated repeat passed. The fixture now records native status transitions with
Session sequence numbers so recurrence can distinguish missing idle notification
from pending persistence. No timeout or assertion was relaxed, and this event is
not classified as a resolved product defect or proof of stable production recovery.


## Ordinary claimed-input factory policy

`createOrdinaryClaimedInputRecoverySetup` adds a trusted setup policy for the
original unpublished native resume factory. It reuses the append-only native
claimed-input restoration algorithm and invariant replay; it does not create or
publish an Agent, open a follow stream, call prompt/send, arm a Goal or authorize
execution. At the policy-only milestone, the ordinary HTTP Host still refused cold claimed input;
this factory policy is a prerequisite for that connection, not an enabled route.

The policy requires the original Gateway binding, a reviewed native replay
profile, an ordinary preset, the exact unpublished Session identity, and a
read-only original-admission provider. The original owner, conversation, product
input ID/content hash and current execution lease are revalidated through the
same read-only binding parser as pending-input recovery. Each recovered human
message must retain the original run RPC source. The native restorer supplies
its canonical full-message SHA-256, covering source, content and attachments,
to the safety callback along with the original queue target and message ID.

An admission provider must return exactly these fields:

```
protocol: 2
run_id, input_message_id, conversation_id, owner_id, session_id
session_created_at, input_sha256
native_message_id, native_message_sha256, profile_fingerprint
```

The Session creation timestamp fences reuse of the same ID. The original
product hash, native message hash and reviewed composition fingerprint all must
match. Missing admissions are refusals; recovery must never create an admission
from the current cold message. The current profile is checked repeatedly, and
a final binding read after awaited admission checks fences lease replacement.
The shared restorer now rereads native history before this final authorization,
so a lease replaced during that awaited history read cannot restore the old input.
Paused/blocked Goals and already-published Agents are refused. The caller still
owns abort binding, the original factory's durable-before-publication barrier,
after-setup composition verification and the later observed execution admission.
A successful setup receipt always says `execution_authorized: false`.

A real Gateway/installed-SDK process test records a synthetic admission before
native input submission, flushes the actual claimed pre-step boundary, and kills
that exact worker. A replacement original lease restores the original input
before factory publication with zero model calls. Corrupt admission, changed
profile and wrong lease are refused before publication. The first restoration
is durably observed and hard-killed; another process reports zero restored and
one already-pending original, without duplicate insertion. A normal Agent
disposal cancels its inbox and must not be substituted for that second crash.
The policy correctly refused that cancelled log during fixture development.

The fixture uses raw native human submission and a reviewed synthetic profile,
not the production Controller prompt/attachment admission path. Durable admission
storage and its original Controller integration, scoped before/after-setup
composition, ordinary Host/Worker connection, steering and monetary/unknown
settlement remain required. No production configuration enables this helper.


## Original Controller prompt admission and private receipts

The optional `ordinaryInputAdmission: {profile, admissions}` Host configuration
observes the original Controller's `agent/inbox/inserted` event. This occurs
when the official Controller has resolved file receipts, checked image capability,
and admitted prompt attachments into its final native user message. Jot does not
replace or duplicate that logic. A scoped observer captures a frozen full-message
hash and the original product binding plus reviewed bound profile fingerprint.
The observer first flushes the original native Session through its canonical
durability listener and only then publishes the private receipt. The original
pre-step waits for both barriers and revalidates ownership,
configuration and unchanged message before allowing its next hook to enter.
The final enter decision must still contain the same original message; a later
hook cannot replace or drop it under an earlier receipt.
Explicit native user cancellation is respected without restoring that input;
admission failure retains known unentered human inputs before a parent cancellation.

`createOrdinaryInputAdmissions({root})` stores one immutable JSON receipt per
Session creation timestamp, original run and native message. The root is
operator-owned and must be outside Agent workspaces. Each entry is limited to
4 KiB, contains only original identities, timestamp and hashes, and is written
through a synced exclusive temporary file followed by an atomic no-overwrite
link. Matching retry writes are idempotent; conflicting records are refused.
Read checks reject symlinks, unexpected fields and inode substitution. Pending
crash-orphan temporary files cannot be read as committed receipts. No message,
image, file bytes, password or login data belongs in these records. Windows tests
need the authorized user context for atomic hard-link publication; sandbox EPERM
is not evidence that a non-atomic overwrite fallback is acceptable.

The internal prompt body can include `ordinary_input: {run_id, execution_lease}`.
Its run must equal the original request ID and cannot carry owner overrides or
workbench authority. An explicitly requested admission requires the configured
Host; there is no ordinary-prompt fallback when it is unavailable. The Client
and Runner preserve this metadata on only the original prompt. With the existing
ordinary recovery flag explicitly enabled, first-generation ordinary Worker runs
supply their original lease; Goal controls, workbench tasks and reclaimed input
recovery keep their separate contracts. Defaults remain unchanged and off.

The SDK's normal RPC deduplication checks committed user messages and pending
queues. A currently claimed-but-unentered message can be absent from both. The
Host keeps the exact live admission in that gap and returns its acceptance
without invoking Controller prompt again. A cold historical insertion with no
live original admission is refused as fresh submission; recovery must never
retroactively certify it. A committed/pending original RPC can be acknowledged
only if its original receipt already exists and still matches.

Real installed-Controller probes cover both an actual first prompt held at the
claimed boundary and normal execution. The former records the original native
message, deduplicates during claim, then survives hard Host death with zero
model calls and no fresh-input replay. The latter calls the scripted model once,
acknowledges a later duplicate without a second model call or receipt, then cold
restarts without activation. A real first-generation Worker additionally publishes
one canonical answer for the original run and retains one admission receipt;
a further poll/restart does not repeat execution. These initial probes use text
input. Native image/file admission behavior is retained by the original code but
requires further model- and receipt-specific integration acceptance.

Receipt creation is now connected to original prompt admission. Connecting cold
claimed restoration through the exact original before/after-setup factory and
parked observer remains incomplete. Unconfirmed admission/storage outcomes are
not not-called or free model attempts, and this is not provider monetary
reconciliation. Existing Goal rearming, steering ownership, consumer rollout,
private storage retention and production acceptance gates remain. Receipts grow
by at most one bounded record per distinct admitted native message; no eviction
policy may remove evidence still required by retained recoverable native history.


The expanded process suite repeated the earlier idle-flush timeout in two existing
cases while the full Gateway suite was also running. Diagnostics now establish
that native idle was observed; the outstanding wait was the subsequent service-wide
persistence barrier. The fixture now uses the SDK's canonical per-Session
`sessions.flush(session)` and verifies the exact expected prefix through a real
read handle before reporting idle-flushed. No deadline or assertion is relaxed.
This improves the specificity of the durability evidence; it does not establish
the cause of the earlier service-wide stall or prove its production resolution.


An admission error after native submission returns a fixed
`ordinary_input_admission_unconfirmed` conflict, not a claim that native input
was definitely rejected. It never exposes internal storage error text. Abort is
checked inside the scheduled original Controller operation as well as at awaited
boundaries; a cancelled queued microtask cannot submit later, and its rejected
promise remains observed. These checks preserve uncertainty without creating a
new prompt or inferring model/accounting completion.


## Durable exclusive step-entry reservation

An unentered-looking cold native log is insufficient evidence of no model call:
step and request events can still be buffered when a process exits. Ordinary
replay now requires a negative entry check backed by the original private
admission store. The service advertises `entryReservationProtocol: 1`; its
admission receipts use **protocol 2**. Legacy protocol-1 admissions are refused,
not upgraded from current content, current profile, or absence of a newer file.
This version boundary is independent of the Gateway binding and native wake
protocols, which retain their existing versions.

Before the final original pre-step returns `enter`, the admission Host atomically
reserves that message's entry slot with `reserveEntry`. The immutable
`.entry.json` record binds the Session incarnation, original run/native message,
admission hash, current execution lease and a fresh Host-local observer ID.
Two competing attempts cannot overwrite or both own that slot. Only the same
exact local attempt can repeat its reservation idempotently; a new Host never
reconstructs activation authority from an old observer ID stored on disk.
The Host rechecks the original authority/profile and native cancellation after
the awaited reservation and before returning the native enter decision.

This record proves **reservation**, not model dispatch, success, usage or cost.
`readReplayCandidate` checks for it before and after reading the original
admission and refuses any existing reservation conservatively. No TTL, lease
replacement, unchanged Goal or missing native step event clears an unknown
reservation. The separate original factory policy now requires this versioned
replay-safe reader. Reconciliation of reserved-but-not-entered, model-dispatched
and settled attempts remains a later accounting/recovery requirement.

The ordinary recovery Host must now have the actual admission gate configured;
it cannot silently use the earlier identity-only path. After preflight and before
native maintenance/wake, it adopts the exact pending original messages through
`adoptRecovered`. Adoption verifies their original protocol-2 receipts, profile,
content, Session sequence and live lease without a prompt or a new admission
write. It returns `execution_authorized: false`. A recovered native pre-step
then competes for its own immutable entry slot through the same gate. A prior
reservation blocks adoption; a competing reservation created after adoption
still blocks its entry. Rebinding stale local guards requires the same live idle
Agent, unchanged exact pending messages and current original authority; it does
not reclaim a reserved entry or revive user cancellation.

The actual HTTP fixture now uses the versioned private admission store for all
ordinary recovery cases, including the explicitly synthetic quiet-input seeds.
Those seeds obtain the real original Gateway binding and reviewed fixture profile;
they are still not production Controller admissions. The actual Controller cases
retain their original initial-admission path. A new hard-process-death probe
stops after the entry reservation is durably published but before native input
commit/model entry. After restart the immutable reservation remains, the replay
reader refuses it, and no fresh model/Agent is activated. This does not classify
that reservation as not-called, certify power-loss durability, or settle cost.

At the entry-reservation milestone, cold claimed-factory integration remained. The reservation gate was added
first so that wiring the factory cannot confuse missing buffered native events
with permission to repeat an already attempted model/tool path. Both existing
Goal switches and ordinary production recovery remain disabled. Storage now has
at most one bounded admission and one bounded entry-reservation payload per
native message, plus filesystem/temporary-file overhead. Retention and unknown
outcome reconciliation must preserve both records together.


### Persistence verification diagnostics

The final native-log prefix read remains an explicit acceptance assertion;
returning from `sessions.flush(session)` alone does not satisfy it. One local
12-case run passed 11 cases and timed out in the ordinary Worker case after the
model response and native idle event. A focused repeat recorded the last stage
as `prefix-read-awaiting`, without an exception or fatal Host output. Isolated
decoding of a captured **synthetic** log passed 100 repetitions; instrumented
focused Worker runs also passed. These observations do not establish the cause
of the original stall or prove a production persistence defect/fix.

A later buffered-diagnostic run exposed a separate, confirmed Windows fixture
fault: the test reader could temporarily deny atomic replacement of its own
`receipt.json`, and the resulting `EPERM` escaped the diagnostic timer. The
fixture receipt writer now retries only `EPERM`, `EACCES` or `EBUSY` rename
contention, at most ten attempts with ten-millisecond pauses, then fails visibly.
Unrelated errors fail immediately. The bytes and atomic rename operation remain
unchanged. This helper is test-only; native logs, private admissions, entry
reservations, model execution, deadlines and prefix equality assertions are not
altered. Optional persistence-method traces and synthetic-byte snapshots are
private diagnostic aids, disabled in normal acceptance. Passing instrumented
runs must not erase earlier failures or count as production rollout evidence.

The final uninstrumented local suite passed 11 of 12 cases, including the
previously stalled Worker and the new reserved-entry hard-death refusal. The
remaining blocked-Goal case exited during Host restart with loopback `listen
EACCES`, before its recovery assertion; its unchanged focused repeat passed.
This is split-run evidence, not a claim of one clean 12-case suite. Adapter
regressions passed 429/429, root tests 32/32, the receipt helper 2/2 and the
Windows build passed. No production enablement follows from these local
scripted-provider and fixture-composition results.


## Observed ordinary claimed-factory connection

Cold ordinary claimed-input restoration can now be composed into the **original**
Controller resume factory, behind explicit operator configuration:

```js
ordinaryInputAdmission: { profile, admissions },
ordinaryInputRecovery: {
  verifyComposition,
  claimedInput: { Session, validateLog }
}
```

`Session` and `validateLog` must come from the reviewed installed native runtime
and its package-owned invariant replay. The admission store must retain the
original protocol-2 receipts and exclusive entry-reservation capability. The
operator must review both prepared and bound compositions. This is not enabled
by an HTTP request body, a preset name or a current source hash alone. Without
`claimedInput`, the previous empty-inbox refusal remains. Defaults stay off.

After a parked original-run observer and cold identity/history/composition
preflight, an empty pending inbox takes the scoped `withResolution` path. Its
AsyncLocalStorage scope admits only the same unpublished **resume** Agent; a
startup, existing resident Agent, duplicate concurrent resolution, unrelated
Session, paused/blocked Goal or missing hook capability refuses. The original
Controller still selects and configures the Agent. No prompt, user-message copy,
new Session, Goal activation, scheduler or model route is substituted.

Before original preset setup, `createOrdinaryClaimedInputRecoverySetup` verifies
the original Gateway identity/current lease, complete native history/invariants,
original full-message hashes, historical profile and absence of an entry
reservation. It restores the original append-only inbox splice. The after-setup
hook verifies the same authority/profile, unchanged Session instance/header, restored inbox and native
history prefix, and no setup-time turn/model/tool entry before original factory
publication. The factory's original suffix flush remains before publication.
The receipt contains `execution_authorized: false`; restoration is not a wake.

The ordinary Host next adopts those exact pending messages through its mandatory
admission gate. Only its existing maintenance/wake path can continue the original
Worker run. Final pre-step still acquires the exclusive entry slot, so a new
reservation arriving after restoration/adoption cannot authorize a duplicate
entry. Caller cancellation is bound into native factory rollback. A late original
operation retains a rejecting scope until it settles; disposing a composer does
not remove its fence while that operation is still live.

A real local HTTP/SDK test now starts with **actual original Controller prompt
admission**, holds after claim but before entry reservation, flushes and kills the
Host, and reclaims the original Gateway run under its next lease. It restores the
original Session/native message, makes one scripted provider request, retains
native usage, and publishes exactly one canonical Worker answer. A further poll
and cold restart do not repeat it. The paired reserved-entry hard-death case
refuses recovery with no Agent/model activation. These cases passed together.

This closes the local opt-in Controller/Host/Worker claimed-factory wiring gate;
it does not complete production acceptance. Source/composition review in these
tests remains fixture-only and model output is scripted. Image/file-specific
recovery, steering across multiple RPC owners, explicit Goal reactivation,
unknown model/tool outcomes and monetary reconciliation, retention, complete
consumer rollout/rollback and real-provider deployment gates remain unfinished.
Reservations are never cleared merely to make recovery succeed.

Upgrading this source does not silently reseal prior admissions with the new
profile fingerprint. If an original receipt's reviewed composition differs,
recovery refuses until a separately reviewed historical compatibility path
exists. A missing admission, old protocol or newly computed current hash is not
permission to migrate or replay old input.

Final local verification for this connection, including the Session/header
fence, passed all 14 real HTTP/SDK cases in one run with no skips, 435 adapter
tests, 32 root tests and the Windows build. Earlier diagnostic failures above
remain historical evidence rather than being relabelled as passes.


## Original attachment recovery integrity

Original image/file references must remain available and intact when an input
is recovered. A reference hash in the admission proves which message was
admitted; it does not prove its binary object still exists. Local testing of
the earlier source confirmed that a removed native file could still reach the
scripted model and complete using the retained prompt text. Retained text alone
must not certify that the full original attachment is usable.

`verifyNativeInputAttachments` now reads **only** the unentered original input's
image/file references through the installed attachment store, verifies their
content-addressed SHA-256 and byte bounds, and returns metadata-only success.
File bytes stream without aggregation and close immediately on exceeding the
original reference size. Images use the native verified reader and are hashed
as stored normalized objects. Missing readers, invalid references, missing or
changed bytes and cancellation refuse; storage paths/error text are not exposed.
This performs no vision inference, upload, receipt re-admission or historical
image rescan. Text-only input performs no binary read.

The scoped claimed factory verifies before and after original preset setup,
before its original publication barrier. The mandatory original-input admission
gate also verifies attachments before adopting pending/recovered messages, then
rechecks authority/profile/idle state before rebinding local guards. A file
changing during setup therefore cannot publish a recovered Agent; a failed
pending adoption does not wake the existing Agent or rewrite its admission.
Normal native permission, model-image capability and original upload/receipt
handling remain unchanged. The continuity audit must cover this helper and the
actual native attachment-store implementation as part of the reviewed source
composition; a current hash by itself is insufficient.

Real local SDK cases create an owned Gateway upload with its original digest,
resolve it through the original attachment resolver, and use the original Runner
to stage a file or submit an image through actual Controller admission. The
fixture manually owns the initial Gateway lease; it is not a whole-process
initial-Worker crash test. It then kills the Host at the actual claim boundary
and uses the real recovering Worker. The admitted native reference is unchanged
after restart, its stored bytes verify, the original Gateway artifact remains
unchanged, no Host file restaging occurs, and only one canonical answer is
published. The image case uses the actual native normalization and provider
Files/Message transport against a scripted local endpoint. It does not measure
real-model visual understanding or real provider billing.

The paired fault cases remove a native file, remove an image, or corrupt a native
file **only after** checking the resolved object remains inside the owned
synthetic test root. Each mutation has an explicit absence/digest assertion.
They must interrupt with no newly published Agent, model request, canonical
answer or entry reservation, while retaining the exact original admission.
An earlier attempt did not actually apply its deletion and is excluded as fault
evidence. The corrected test against the previous source reproduced the bug;
the fixed source passed all five attachment cases together. An initially invalid
PNG fixture was also rejected by native validation and replaced with a generated
checksummed synthetic PNG; native image validation was not relaxed.

This closes the local basic file/PNG transport and recovery-integrity cases.
Other formats, large/complex documents, steering, production composition review,
real-provider semantics, unknown cost reconciliation, retention/restore policy
and deployment acceptance remain separate requirements. No recovery/Goal
production switch is enabled.

Final verification including both recovery gates passed 19/19 real local SDK
cases in one run with no skips, 441 adapter tests, 32 root tests and the
Windows build. The real providers remain scripted; no production enablement
or monetary/visual-quality acceptance is implied.


## Steering command lineage preparation

The native steering RPC is the durable command ID, distinct from the parent
run's initial-input RPC. The existing original-input Host does not yet admit
this as an owned supplement. Broadening its RPC filter, reusing the run ID or
resubmitting the initial prompt would not solve the ownership/replay problem.

A new read-only internal `ordinary-steering-binding` route prepares the missing
identity proof. It derives the command, deterministic future product message,
parent owner/conversation/original input, owner-bound Session and live lease
from the existing Gateway records in one transaction. Pending and applied
commands produce the same stable identity; a command's later state is checked
but not included as immutable admission data. Applied commands require the
exact committed user message. ID/client-message collisions, conflicting
content, future run versions, wrong command kind/state, archived/stopped parent
runs and invalid scope/lease refuse. The response returns only IDs and hashes,
with `execution_authorized: false`; it writes no admission or product message
and acquires no lease.

The product-message hash uses the dispatcher's current exact representation.
`native_content_sha256` separately describes the existing trimmed native wire
text parts. The command payload and parent input have their own hashes. An
API read does not freeze database records: future consumers must compare these
facts to the original per-message admission and reject changes, rather than
resealing them at recovery time. Authentication and the exact request envelope
are mandatory; caller-supplied owner/content overrides are rejected.

This route alone does **not** fix or enable steering recovery. The dispatcher
still needs its originally owned lease, the Client/Host still need explicit
command admission, and later claimed supplements need a verified completed-step
boundary plus canonical delivery and cost reconciliation. Native rc2 can take
several steps inside a turn, so removing the current whole-turn recovery guard
is unsafe. The complete implementation/acceptance sequence is in
[Steering lineage and recovery](superpowers/plans/2026-10-16-steering-lineage-and-recovery.md).
No production continuation switch changes with this preparation.

## Opt-in live steering checkpoint

The originally owned ready Worker lease now travels through a separate
`ordinary_steer` transport contract. Command IDs keep their official native
RPC identity. Protocol-3 steering admissions bind both original input and
normalized native command content; protocol-2 original admissions and entry
reservations retain their existing semantics. An observed recovered Host
accepts a live supplement only after exact command admission and scope checks.
The Dispatcher revalidates the original lease and immutable command proof
inside product-message persistence after native acknowledgement.

`GENERAL_AGENT_ORDINARY_STEERING_ENABLED=false` is the default and enabling it
requires ordinary input recovery. A real local SDK fixture has verified an
original recovering Worker plus one live supplement, two model/usage records,
one canonical answer, no repeated dispatch and no repeated calls after restart.
Providers are scripted local fixtures. Cold later-step recovery, multiple
supplement ordering, lost acknowledgement reconciliation, unknown fees and
production acceptance are still required. In this opt-in path, unresolved
terminal commands stay pending rather than starting speculative fallback runs.
See the staged plan above for the remaining gates; this is not full steering
or production completion.

## Cold pending steering checkpoint

The opt-in original recovery Host now validates each pending command's parent,
RPC, normalized content, original protocol-3 admission and exact new Worker
lease. It uses the explicit per-message native maintenance binding, preserves
completed parent history and never re-prompts the root. Actual local SDK tests
cover one/two queued supplements after Host death, unchanged original log and
admission/reservation bytes, one canonical answer, and refusal of reserved or
changed commands without new model calls. The first Runner lease is held by the
fixture; only the recovering phase runs the real Worker. Providers are scripted.
Later already-claimed steering, historical terminal acknowledgement uncertainty,
monetary reconciliation and production acceptance remain incomplete. See the
[staged steering plan](superpowers/plans/2026-10-16-steering-lineage-and-recovery.md).

## Later-step claimed steering checkpoint

Ordinary claimed recovery can now select proven unentered claims after the last
matched closed step, following whole-log official invariant validation. This is
an explicit ordinary policy; generic native restoration retains its old default.
The original unpublished factory verifies each command's protocol-3 admission
and rechecks it after setup before publication. Existing entry reservations,
changed commands and foreign authority refuse without replay. Prior model/tool
outcomes and unknown costs are preserved, not inferred from a step closer.

Four real local SDK Host-death cases cover one/two claimed commands plus reserved
and changed-command refusal. The recovering phase uses the actual original-run
Worker and preserves old native prefix/usage/private records, one canonical
answer and no prior-call repetition. The first Runner lease is fixture-held,
providers are scripted, and monetary/production acceptance remains open. See
[the staged steering plan](superpowers/plans/2026-10-16-steering-lineage-and-recovery.md).

Cold claimed composition also covers the mixed state where one command has been
claimed and another remains pending. Interrupted history uses the original
factory despite a nonempty queue; every surviving message needs its original
admission before publication. Without the required claim factory, a possible
unentered claim window refuses. The real mixed Host-death case preserves both
RPCs/order and one canonical result; terminal publication/acknowledgement races
remain a separate open gate in the staged plan.

## Ordinary final-answer coverage

Opt-in ordinary steering now keeps the original live Runner until its observed
final answer follows every admitted command RPC and the product receipts are
settled. A hash-only existing-Agent completion read checks original admissions,
answer sequence/hash, parent/lease and native completion; it never creates or
wakes execution. The original Worker publishes while that Runner is still alive
and rechecks the command set inside canonical finalization. A new command during
output resolution invalidates stale coverage. Exact-RPC acknowledgement retry
needs no new prompt or model call.

This is selected by `GENERAL_AGENT_ORDINARY_STEERING_ENABLED=true`, requires the
matching completion-capable Runner/Adapter and recovery configuration, and stays
off by default. Local actual-SDK boundary/lost-ack tests pass. Historical terminal
reconciliation, concurrent explicit Goal reactivation, unknown money, rolling
upgrades and production acceptance remain open; see the staged plan.

## Historical ordinary source inspection

A separate internal bearer-authenticated terminal source endpoint now verifies
owner/conversation/Session/run/command and an exact expected run version. It
returns hashes and product state without raw text or an execution lease. Native
acceptance is always unverified. It cannot resume cancelled work, create an
Agent, repair acknowledgement, or settle cost. The live steering/lease contracts
are unchanged. Native history/admission/entry joining and atomic historical
repair remain incomplete. See the steering implementation plan.

An isolated historical observation factory now joins that product source to the
original raw Session prefix, official detached invariants and immutable input/
entry records. It returns hash-only facts without activating a driver. Local
actual-SDK lost-ACK/Host-death and raw open-step cases preserve log/admission
bytes; logical cold closers cannot certify completion. This adds observation,
not deployed reconciliation transport, ACK repair, canonical final publication
or monetary settlement. Those delivery gates remain open.
