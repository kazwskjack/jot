# Ordinary Goal continuation

DSH owns Goal state and automatic rounds. Human pause, resume and stop requests do not grant new tool permissions or certify a task's completion. Ordinary conversation controls remain separate from role and persistent-task Goals.

## Implemented control record

`ConversationGoalControls` stores an explicit resume request and its eventual Host receipt in the existing Gateway SQLite database. It is an execution intent, not a second Goal store. Admission pins the owner, conversation, existing native Session, exact Goal ID/revision, originating run and idempotency key.

A continuation uses the existing `ga_runs`, Coordinator lease, event stream and outbox. It references the preceding input for lineage; it does not create another human message. The Worker supplies an empty message and no attachments to a distinct `resumeGoal` runner entry. A mixed-version runner without that entry interrupts the control run rather than sending the original prompt again.

The dispatch boundary records the official follower's opening cursor and the exact Worker lease generation. Only the first `begin` returns `acquired: true`. A repeated `begin` does **not** authorize another mutation. An unconfirmed dispatch fences new attempts even after the product run ends. Reopening the database preserves the original request and receipt.

An applied receipt must contain the same Goal ID, the next revision and native active/armed state. Identity, dispatch metadata and final receipts cannot be overwritten. A stale lease, changed Session, archived conversation, cancellation, role/task scope or mismatched source run invalidates execution. The Worker cannot become ready, publish projections, attach generated artifacts or publish a final answer before the applied receipt exists.

## Remaining integration

This record and Worker path are not yet exposed as the public resume API. The current `OfficialSessionRunner` does not implement `resumeGoal`; the mixed-version refusal remains intentional until the following chain is verified:

The refusal belongs to the updated Worker when its runner lacks continuation support. It is not a guarantee about historical Worker binaries. Public admission must remain off until every process consuming the original run queue has the new no-replay path; a partially upgraded pool is not ready.

1. Accept the human control and its original-key receipt atomically in the existing authenticated Gateway route.
2. Attach the official cold-safe follow stream before resolving or resuming the Agent. A product `running` status is insufficient proof of a live follower.
3. In the trusted Host, verify that exact follower and lease, use original Agent maintenance and native Goal CAS, flush native persistence, then commit the control receipt before releasing automatic rounds.
4. Observe native events, outputs and original usage through the same run. Do not create a model "continue" prompt, replay images, introduce a second planner or bypass the original permission/budget path.
5. Reconcile lost acknowledgements and process exits without repeating an unknown mutation. A new lease cannot replay an old dispatch. Human pause/stop remain authoritative.
6. Verify the real locked SDK with a local scripted model, then separately verify a synthetic deployed conversation. A fake runner unit test is not native or production acceptance.

The installed SDK's normal follow request has no `afterSeq` field. Recovery must use supported history/follow semantics; adding an undocumented request property is not a recovery implementation.

## Local verification

```sh
node --test packages/gateway/test/harness/conversation-goal-controls.test.mjs packages/gateway/test/harness/worker.test.mjs
```

These tests use isolated SQLite files and an injected runner. They cover durable command/receipt storage, original-run lineage and publication, owner/session/lease fences, transaction rollback, restart and mixed-version no-replay behavior. They do not execute a native Goal or claim a model, budget or production acceptance result.
