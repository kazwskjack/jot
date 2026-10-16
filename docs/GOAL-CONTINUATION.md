# Ordinary Goal continuation

DSH owns Goal state and automatic rounds. Human pause, resume and stop requests do not grant new tool permissions or certify a task's completion. Ordinary conversation controls remain separate from role and persistent-task Goals.

## Implemented control record

`ConversationGoalControls` stores an explicit resume request and its eventual Host receipt in the existing Gateway SQLite database. It is an execution intent, not a second Goal store. Admission pins the owner, conversation, existing native Session, exact Goal ID/revision, originating run and idempotency key.

A continuation uses the existing `ga_runs`, Coordinator lease, event stream and outbox. It references the preceding input for lineage; it does not create another human message. The Worker supplies an empty message and no attachments to a distinct `resumeGoal` runner entry. A mixed-version runner without that entry interrupts the control run rather than sending the original prompt again.

The dispatch boundary records the official follower's opening cursor and the exact Worker lease generation. Only the first `begin` returns `acquired: true`. A repeated `begin` does **not** authorize another mutation. An unconfirmed dispatch fences new attempts even after the product run ends. Reopening the database preserves the original request and receipt.

An applied receipt must contain the same Goal ID, the next revision and native active/armed state. Identity, dispatch metadata and final receipts cannot be overwritten. A stale lease, changed Session, archived conversation, cancellation, role/task scope or mismatched source run invalidates execution. The Worker cannot become ready, publish projections, attach generated artifacts or publish a final answer before the applied receipt exists.

## Observed Host and original Runner

The opt-in Host backend now attaches the official cold-safe follow stream before resolving an Agent. One exact control, run, Session and lease generation owns that live observer. The internal Gateway endpoint uses the existing service credential and rejects owner overrides, foreign run/Session identities and stale leases.

After validating the ordinary preset, empty inbox and closed history, the Host uses the official resolver and `runMaintenance`. It begins the original dispatch once, resumes through native Goal CAS, flushes native persistence and commits the applied control receipt before releasing automatic rounds. Lost HTTP acknowledgements reuse the same process-local operation promise. A lost persisted-receipt acknowledgement can reconcile that original receipt without repeating native resume. New Host processes or followers do not turn an old receipt into activation authority.

Original step, tool and LLM middleware recheck the live observer and original lease. They preserve the existing native execution/permission chain and provider chunks. The LLM waterfall returns an AsyncIterable synchronously, as required by the SDK. Disconnect disarms future continuation and cancels its controlled in-flight turn; disposal also aborts the original follow. Durable Goal phase is not rewritten to pretend completion.

`OfficialSessionRunner.resumeGoal` now follows first, sends the bounded human control and observes subsequent native events on the same iterator. It never creates an Agent before observation or sends a new human prompt. Invalid refs and malformed cursors are refused before activation. Normal message handling keeps its existing path.

The Host option `conversationGoalResume: true` requires the existing internal Gateway token. It is off by default, and the standard profile does not enable it. The public resume route and UI have not yet been switched to this admission.

## Remaining acceptance

1. Accept the human control and original-key 202 receipt atomically in the existing public authenticated Gateway route; expose pending/unknown execution separately from Goal completion in the UI.
2. Verify every consumer of the original run queue has the updated continuation path before enabling public admission. The updated Worker's refusal with a legacy runner does not protect historical Worker binaries.
3. Complete process-exit and reply-loss reconciliation at all dispatch/flush/publication boundaries. Pending/claimed input and interrupted history require supported recovery; current preflight refuses them before activation.
4. Keep unknown mutations fenced. A new lease cannot replay an old dispatch. Human pause/stop remain authoritative, and a current native state that happens to match is not proof of a prior operation receipt.
5. Separately verify a synthetic deployed conversation and deployment rollback. Local model fixtures do not prove real-provider quality, production usage accounting or comprehensive crash recovery.

The installed SDK's normal follow request has no `afterSeq` field. Recovery must use supported history/follow semantics; adding an undocumented request property is not a recovery implementation.

## Verification

```sh
node --test packages/gateway/test/harness/conversation-goal-controls.test.mjs packages/gateway/test/harness/worker.test.mjs
node --test packages/session-adapter/test/conversation-goal-run-host.test.mjs
node --test --test-concurrency=1 packages/dsh-host/test/observed-goal.test.mjs
```

The first tests use isolated SQLite files and an injected runner. The last test requires `JOT_DSH_RUNTIME_MODULES` pointing to the installed locked SDK package directory; without it, the native cases are explicitly skipped. It starts a real official Host, real Gateway and local synthetic HTTP model, restarts the Host, then checks both direct observed resume and original Worker publication. The native Goal finishes after three scripted model requests, the original human prompt is absent from provider inputs, only one assistant answer is published, and another Host restart preserves completion without inference. These are local SDK/integration results, not production or real-provider acceptance.
