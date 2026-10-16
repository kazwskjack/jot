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

After validating the ordinary preset, empty inbox and closed history, the Host uses the official resolver and `runMaintenance`. It begins the original dispatch once, resumes through native Goal CAS, flushes native persistence and commits the applied control receipt before releasing automatic rounds. Lost HTTP acknowledgements reuse the same process-local operation promise. A lost persisted-receipt acknowledgement can reconcile that original receipt without repeating native resume. New Host processes or followers do not turn an old receipt into activation authority.

Original step, tool and LLM middleware recheck the live observer, original lease and current native Goal identity. An old receipt cannot authorize a replacement Goal in the same Session; a closing answer for the same completed Goal remains permitted. They preserve the existing native execution/permission chain and provider chunks. The LLM waterfall returns an AsyncIterable synchronously, as required by the SDK. Disconnect disarms future continuation and cancels its controlled in-flight turn; disposal also aborts the original follow. Durable Goal phase is not rewritten to pretend completion.

`OfficialSessionRunner.resumeGoal` now follows first, sends the bounded human control and observes subsequent native events on the same iterator. It never creates an Agent before observation or sends a new human prompt. Invalid refs and malformed cursors are refused before activation. Normal message handling keeps its existing path.

The Host option `conversationGoalResume: true` requires the existing internal Gateway token. It is off by default, and the standard profile does not enable it. The authenticated public resume route and ordinary-chat UI now use this admission when the separate Gateway rollout option is enabled.

## Public admission and display

`GET /v1/conversations/{id}/goal/resume-readiness` checks the original queue, existing Session and configured Host capability without activating an Agent. It returns enabled/ready flags plus a fixed reason. A busy product run, unconfirmed dispatch, missing Session or unavailable Host cannot admit a new continuation. A running product status alone is never proof of an attached native follower.

`POST /v1/conversations/{id}/goal` with `action: "resume"` retains the exact native ID/revision and original idempotency key. Admission creates the intent, original queued run/outbox/event and **202 acceptance receipt** in the existing atomic transaction. Its body is `{accepted, control_id, run_id, conversation_id}`; it is not a Goal state or completion receipt. A response lost after commit recovers the same receipt even when the Host is offline. A typed reservation interrupted before admission can retry its original request without duplicating a run. Conflicting payloads cannot reuse a key.

The ordinary Goal card follows that control run separately from native Goal state. It shows acceptance while native restoration is pending, continues polling even while the product run is queued, and only shows completion from a validated native Goal view. Unknown replies retain the exact original request for retry. Browser forced-reload/crash recovery of a request not yet acknowledged is still incomplete; the current page warns before navigation. Role and persistent-task conversations keep their existing scoped paths.

Gateway `GENERAL_AGENT_CONVERSATION_GOAL_RESUME_ENABLED` defaults to false. Enable it only after the full consumer pool is upgraded and the recovery/deployment gates below pass, alongside the trusted Host `conversationGoalResume: true` option. Neither switch is enabled in the standard profile by these changes. The readiness endpoint reports configured capability and current admission facts; it is not an audit of every historical Worker binary or a guarantee that a particular cold history is recoverable.

## Remaining acceptance

1. Verify every consumer of the original run queue has the updated continuation path before enabling admission. A historical consumer may not make progress on message-free continuation records, even though the old input join cannot replay the original message.
2. Complete process-exit and reply-loss reconciliation at all dispatch/flush/publication boundaries. Pending/claimed input and interrupted history require supported recovery; current preflight refuses them before activation.
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
Host termination at two verified boundaries: native persistence completed but
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
settlement, publication transactions or pending/claimed/interrupted-history
recovery. They are tracked separately from the two actual process-termination
boundaries above. Neither test scaffolding nor a safe refusal substitutes for
those remaining implementation and deployed acceptance requirements.

| Interruption boundary | Required evidence and behavior | Current evidence |
| --- | --- | --- |
| Public reservation before atomic admission | Same original key may recover; no duplicate queued job or native activation | Gateway typed-reservation and lost-reply route tests |
| Public 202 committed, before native work | Recover the same control/run receipt even if Host is offline | Public API tests and installed-SDK public Worker probe |
| Opening snapshot, before maintenance | Subscriptions buffer events; no post-snapshot promotion or pending-input activation | Iterator unit test and installed-SDK zero-Agent/zero-model refusal |
| Begin response lost, native call not invoked | Only the same live observer can attest not-called; a replacement observer cannot close its dispatch | Host injected fault, immutable observer journal and internal-route tests |
| Native invocation appends then throws | Disarm controlled execution; retain uncertainty; never claim not-called | Host injected native-call failure test |
| Native flush completed, before applied commit | Restart disarmed; zero inference/publication; keep unknown dispatch fenced | Actual isolated Host termination probe |
| Applied commit, before its acknowledgement | Retain the original receipt; restart disarmed; never infer execution completion from acceptance | Actual isolated Host termination probe |
| Inside native CAS/flush, provider usage settlement, final publication commit | Reconcile exact native events, original cost holds and one canonical output without replay | Additional process-exit acceptance remains required |
| Browser exits before control acknowledgement | Restore the exact original owner-scoped command/key, never infer its receipt from current Goal state | Persistent browser-command recovery remains incomplete |
| Parked/claimed input or interrupted turn | Use supported original native recovery without consuming or dropping pending input | Refusal is verified; full supported recovery remains incomplete |
