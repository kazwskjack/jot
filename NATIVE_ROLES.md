# Native role integration

## Completion and cost boundaries

A task cannot create its acceptance candidate while an owned native reservation
or activation in that occurrence has no closure. A closed original child does
not close a later activation. Pending, in-flight, unknown or exceeded native
model usage also blocks the candidate independently of closure checks.

The frozen cost journal includes task, mailbox and native executions through
one owner/occurrence-scoped distinct run set. It retains released reservations
as audit records, records actual settled child/activation usage exactly once,
and rechecks the same set before owner acceptance. Another occurrence's open
native work does not contaminate this review. Freezing relinquishes the root
worker lease; the existing native admission rules reject later creation or
reactivation rather than extending that review's authority.

These checks do not solve an unresolved spawn: a durable reservation without a
bound child run is still pending. There is no reservation-level abort API in
this release. Preserve the original request/Session identity for trusted host
reconciliation; do not delete records, fabricate closure, retry with a new ID or
release uncertain capacity merely because a timeout elapsed. Proven
not-created recovery and end-user recovery controls remain required before
treating the optional native-role integration as generally enabled. The
generated official host profile continues to set `nativeRoles: false`.

Native child-file delivery still requires precise step-assignment/receipt
lineage and parent-conversation publication. The cost union above grants no
file access or blanket acceptance of child outputs.

Jot can bridge saved roles to a DSH native Team host while keeping the lead Agent responsible for planning and the final answer. This is an optional extended gateway integration; the portable root runtime is independently runnable.

## Runtime and configuration

Use a host that provides the native Team/provider, durable Session persistence and Session projection APIs required by `native-role-host.js`. The integration targets the `0.2.0-rc.2` host family. The package also supports older Controller transport, but that does not imply native Team support on `0.1.7-alpha.2`.

All native-role flags default to **false**. Enable them only after validating the host and matching gateway together:

```js
{
  nativeContinuation: true,
  nativeRoles: true,
  nativeRoleRecovery: false,
  workbenchOrigin: 'http://127.0.0.1:18831',
  workbenchTokenEnv: 'GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN',
  workbenchModel: { provider: 'your-provider', model: 'your-model' }
}
```

Register the actual provider, model and allowed preset in your host. Configure adapter and internal gateway secrets separately outside Git. Validate the configured model route and budget callback before dispatch. Set `nativeRoleRecovery: true` only after the restart tests below pass in your own environment.

## Execution and recovery

1. Authorize a saved member role against the lead's owner, project, workspace, task policy and current worker lease.
2. Persist a reservation before native publication. It grants no model or tool execution by itself.
3. Bind the child Session to its own execution identity and the original budget scopes. Select the model before publication.
4. Persist publication under the request's semantic hash. Retrying the same request retrieves its publication; changed content conflicts rather than creating another member.
5. Close an execution only from durable Session receipts and settled usage. Parking a child is not business completion.
6. For a cold activation, verify the original Session prefix and create a new fenced execution identity. Unresolved dispatched usage remains unknown and held; it cannot be erased by restarting.

Members share an authorized workspace and budget lineage. This does not copy unrestricted credentials or turn every role into the lead. The legacy queued worker excludes native members to avoid double execution. Shared capacity reservation permits known parallel member calls, while unknown or exceeded costs fence the lineage.

The authenticated adapter exposes `POST /v1/sessions/{id}/native-members`. Its identifiers are internal host IDs; browsers must use an owner-checked gateway facade. The caller cannot supply a run ID, lease or owner. The ordinary native Goal endpoint supports status, pause, resume and stop with exact revision checks; it cannot create goals or claim completion.

## Verification and remaining work

The repository includes fixture tests for admission, ownership, revocation, idempotency, publication recovery, immutable closure receipts, separate activations, shared accounting and authenticated endpoints. These tests use synthetic data and scripted providers. They do not establish production browser, live-model or notification readiness.

Before deployment, verify both normal restart and abrupt exit, two concurrent members, cancellation and permission revocation. Confirm no duplicate member, model request or tool execution; preserve unknown usage; reject stale revisions and leases. Then test a real configured model and tools in an isolated owner account.

When `nativeRoles` is explicitly enabled, the model-callable `tasks.delegate` path now dispatches through the original native Team host. Full Handoff/fork/Swarm behavior and business acceptance remain separate work. Enabling a host flag does not complete these paths. Keep the integration off until your required path has been wired and accepted.

## Local release checks

At the initial native-dispatch milestone, Windows with Node 24 checks passed 173 Session adapter tests, 31 portable runtime tests and five actual SDK runtime scenarios without skips. The web build passed. The prior focused gateway check passed 40 tests; its most recent full check passed 945 tests with six POSIX/Office cases skipped. Gateway source was unchanged at that milestone. These are historical local checks with scripted model responses, not external-provider or production acceptance.

## Native delegation intent journal

`NativeTaskIntents` and the authenticated internal `native-task-intent` endpoint prepare an immutable assignment plan from a lead's existing task step. They bind the request to the owner, current occurrence, role grant and step revision. The endpoint also validates the original worker fence. Retries revalidate permission and return the same plan; changed arguments conflict, and edited steps or revoked grants reject replay.

Planning does not reserve a child, enqueue the legacy mailbox, change a step to running, invoke a model or prove completion. `execution_authorized: false` is intentional. With `nativeRoles: true`, the model-callable `tasks.delegate` path uses the immutable intent, assignment-bound reservation and native Host publication. With the flag disabled, it retains the original queue implementation. A native failure is surfaced without legacy fallback; never call both dispatch paths for one request.


## Bound member assignments and evidence

When a reservation matches a saved native task intent, the gateway validates the role/policy and step revision, verifies prerequisite evidence, transitions the step to running through the original task service and saves its frozen assignment in the same transaction as the reservation. A failed reservation write rolls back the transition. Retrying cannot consume another slot or change the assignment. A host with a matching plan cannot omit the assignment service.

Child model/tool admission rechecks the current running step and revision as well as the original native owner, role, parent lease and budget. Editing or blocking a step revokes its member's new execution. Cold activations retain the same assignment; they do not reset task progress or grant fresh permission.

Actual member workspace operations return persisted execution receipts. Assigned-member receipts can be verified against the original owner/task/occurrence and result hash. Generic native roles without a task assignment do not contribute parent-task evidence. Receipts remain historical evidence after a step changes; they do not keep execution authority alive or prove that acceptance criteria were met. The member cannot update the parent task ledger; the lead must review materials and update the original step.

The adapter now composes these boundaries with native dispatch. Keep native flags off until the required restart, production-provider and tool paths are accepted in your environment.


## Reproduce the model-callable path

Provide an installed DSH `0.2.0-rc.2` host module directory through `JOT_DSH_RUNTIME_MODULES` (the directory containing the `@deepseek-ai` packages), then run:

```sh
node --test packages/session-adapter/verification/native-task-delegate-runtime.mjs
```

Without that explicit SDK path the optional test is skipped. With it, the test mounts the actual SDK, formal adapter `apply`, Session Controller, native Team and isolated gateway, then emits a real model tool call using a local scripted provider. It verifies one intent/reservation/publication, a member file write and owned receipt, no legacy task, and a successful native tool result delivered to the lead. Upload and archive leaves are inert test facades; this is not their acceptance or a live-provider test.

Native internal handles are stable lowercase identifiers derived from role and request identity, satisfying Team name constraints. Human role names, including Chinese names, remain in the saved role context; the handle does not change its permissions or identity. Packaging includes the dispatcher runtime module.


## Parent pause and lost-receipt recovery

Native Host admission installs a parent authority callback on every child binding. Each model/tool boundary checks it before and after the gateway guard read. Reattachment cannot remove it. Pausing the native lead Goal rejects the member's next model/tool dispatch; already dispatched usage still settles through the original accounting path. A pause does not fabricate failed usage or automatically release every undispatched admission hold; the original worker/checkpoint lifecycle owns those holds.

The optional SDK checks also cover:

```sh
node --test packages/session-adapter/verification/native-task-pause-runtime.mjs
node --test packages/session-adapter/verification/native-task-restart-runtime.mjs
```

They require the same explicit `JOT_DSH_RUNTIME_MODULES` setting. The pause test changes the actual native Goal during a member's first scripted model call: no file is written, neither Agent dispatches a second model, and the two already sent calls remain settled. The restart test runs two separate OS processes: the first creates a member but loses the publication acknowledgement before persistence; the second recovers that exact member without another model call, then cold-activates the original Session with its assignment and shared accounting intact.

The normal scenario tests model-callable tool dispatch; the restart scenario invokes the same host dispatcher directly to isolate metadata recovery. They do not prove automatic recovery of every interrupted model tool call, hard-kill unknown usage, all parallel/cancellation paths, or production integrations.

## Parallel assignment and Goal stop

With native delegation enabled, only `jot_workspace` calls whose operation is `tasks.delegate` declare SDK concurrency safety. The SDK can overlap those dispatches; the gateway still validates each assignment, step revision, role permission and configured capacity transactionally. Other workspace operations, including file writes and memory changes, retain exclusive tool execution. This declaration does not increase configured limits or enable native roles by default.

```sh
node --test packages/session-adapter/verification/native-task-parallel-runtime.mjs
node --test packages/session-adapter/verification/native-task-stop-runtime.mjs
```

Both require the explicit installed SDK path described above. The parallel scenario emits two delegation calls in one actual model tool batch and waits until both member models are in flight. It verifies a peak of two, two assignment-bound publications, separate file writes and receipts belonging to the original task, and no legacy queued delegation. The lead still needs to review the materials; the running steps are not reported as completed.

The stop scenario performs the native Goal pause-and-clear sequence while a member model call is in flight. Neither Agent dispatches another model call, the member's following file write is rejected, and already dispatched usage settles normally. This verifies Goal stop, not every HTTP turn-cancel or worker interruption path. Upload/archive leaves remain inert in these probes. Full production provider/tool acceptance, abrupt-crash unknown usage, Handoff/fork/Swarm and broader cancellation remain separate gates.

## Owner cancellation of a task occurrence

```sh
node --test packages/session-adapter/verification/native-task-cancel-runtime.mjs
```

With the same explicit SDK setting, this scenario cancels the original task occurrence through the actual gateway HTTP route during a member's first scripted model request. A different owner is rejected without changing the run. The owner request and its idempotent replay are accepted, persist exactly one cancel command and transition the original run to `cancelling`. Neither the lead nor the member dispatches another model request; the following member file write is rejected. Already dispatched usage settles without invented refunds, and no legacy delegation is created.

After the execution fence settles the two dispatched model requests, the scenario drives the original worker `SessionCommandDispatcher`. It calls the actual authenticated adapter Session `/cancel` endpoint, checks its attached-Agent idle receipt, and then verifies the original run becomes `cancelled` with `USER_CANCELLED`, the command is applied and exactly one cancellation event is saved. Processing again sends no second cancellation, and the accounting rows are unchanged. An unauthenticated adapter cancel request is rejected.

This verifies the in-flight execution fence and the worker command dispatcher's subsequent final run projection. It does not exercise the complete worker scheduling loop, transport abort during an unfinished model stream, cancellation during every external tool, or process-kill recovery. The adapter Session `/cancel` route and persistent-task occurrence cancellation have different scopes; callers must use the appropriate owner-checked gateway operation.

## Abrupt member process exit and unknown usage

```sh
node --test packages/session-adapter/verification/native-task-crash-runtime.mjs
```

With the installed SDK setting, the first isolated OS process starts an actual native member model request, verifies its committed `in_flight` accounting row, flushes the Session prefix and exits directly without disposing the host or returning usage. A second OS process reopens the same database. Recovery under the original lease is rejected; a replacement lease can classify the lost member request as `unknown`. Repeating classification changes nothing.

The probe verifies the original budget balances and held amounts remain unchanged, the dispatched request cannot be released as an undispatched hold, a new parent request is blocked by unknown usage, and there is still exactly one member reservation with no closure, file write or legacy delegation. Recovery does not invent usage or completion. This tests abrupt process exit at a specific member-stream boundary with synthetic responses, not a power loss, byte-torn persistence, real-provider reconciliation or automatic production worker takeover.

## Handoff controller foundation

`packages/gateway/src/workbench/task-handoff.ts` implements a persistent, single-controller state machine keyed by owner and original root run. It records immutable request receipts, revision-checked transfers, a frozen authority/lease snapshot, bounded hops and the visited route. Returning to the lead closes the chain; stopping closes it without creating a replacement chain. Repeated non-lead routes are rejected. Replaying an old receipt is not current control authority: execution must validate the latest revision and controller.

The module requires a trusted host authorizer on every operation, including replay. That authorizer must check the original task, role policy, worker lease and budget; controller checks must be composed inside the host's original execution admission transaction. This module does not dispatch models/tools, reclaim expired leases or prove task acceptance. At this gateway-management milestone, native-host orchestration and UI were still pending; subsequent sections document later host-side additions. Full Handoff/Swarm execution remains gated on end-to-end lifecycle acceptance. Root planning and final-answer responsibility stay with DSH.

`task-handoff-host.ts` provides the task-bound management adapter. It binds the original owner/root run, exact collaboration policy and worker lease, reuses original task/role validation, and previews the configured model budget without reserving or spending it. Starting or transferring waits for all related model usage to be settled; pending or unknown usage blocks the transition. Stop can close management control while usage is pending without refunding it. Policy changes, worker replacement and occurrence cancellation reject further control changes.

This adapter is still not an execution grant or a public route. A role may have multiple native Sessions: actual transfer must additionally bind one concrete execution identity, settle prior effects and compose its controller revision with each operation's original admission. At this adapter milestone, those native-host and UI steps remained pending; subsequent sections document later host-side admission work. A role name alone cannot authorize a Session.

The task-bound adapter now includes `bindExecution` and `assertExecution` for one exact run/Session per controller revision. Binding validates the original Session registry, current role and native root lineage, worker lease and original run/assignment permissions. Stored bindings cannot be updated or deleted. Another execution of the same saved role cannot inherit or replace a binding. A transfer or stop invalidates the old revision.

The original gateway tool guard and workspace operation transactions now check the current handoff controller and exact execution binding when a handoff record exists. Unbound or non-controller instances are rejected before new workspace effects, including calls from another native Session of the same role. Stopped control denies tools; returning to the lead permits only the original lead run to use the finalization path. Ordinary tasks without a handoff record retain their existing behavior. Planning and accounting reads remain separate.

The operation fence rechecks the frozen worker lease and exact collaboration policy. Older control records without those frozen fields fail closed; they are not silently upgraded to new authority. Only the authenticated internal management transport exposes control changes; no model tool or public UI does. At this gateway-fence milestone, native-host transfer and UI enablement remained pending; subsequent sections document later host-side admission work. Production enablement still depends on external-effect reconciliation. This gateway check does not stop already dispatched remote effects or prove their outcome; verify those before activating the receiver. DSH planning/final-answer behavior must remain separate from step execution control.

Handoff management also checks the original worker's persisted web-operation cursor observations. The worker records the validated operation status and whether every accepted item has a known terminal outcome, in the same transaction as its revision and activity event. A running/unknown operation, terminal aggregate with unresolved items, missing outcome or truncated item set prevents a transfer even after model usage has settled. Stale snapshots do not replace newer facts.

The database migration leaves historical observations unresolved; it does not infer completion from an old cursor or display message. They need a newer validated operation observation. This closes the barrier for operations already observed by the original worker. It does not establish discovery of every remote effect, cancel an external operation or replace provider-side reconciliation. At this barrier milestone, native-host orchestration was still pending; later sections document subsequent host-side transitions. Production Handoff remains gated on live provider-side reconciliation.

An observation can release this barrier only when its accepted count is an explicit nonnegative integer and its complete item manifest has unique valid IDs and positions, with a known terminal outcome for every item. Missing or string-valued counts, truncated manifests and duplicate items remain unresolved even if the display reports completion. A newer complete observation can resolve the same operation; stale snapshots cannot do so.

## Authenticated handoff management transport

The trusted host can POST to `/internal/v1/workbench/handoff` through its existing authenticated bridge. Every request includes the original root `run_id`, `session_ref`, exact `execution_lease`, `expected_policy_version`, configured `route` (`provider` and `model`) and an action-specific `request` object. Owner and task identity are resolved from the original binding; caller-supplied owner fields are rejected.

| Action | Request fields | Result |
| --- | --- | --- |
| `get` | Empty object | Current control state after authority validation |
| `start` | `request_id`, `max_hops` | Control state and exact original lead binding in one transaction |
| `transfer` | `request_id`, `expected_revision`, `from`, `to`, `execution_run_id`, `execution_session_ref` | Transfer and exact receiver binding in one transaction; a bad binding rolls back the transfer and receipt |
| `stop` | `request_id`, `expected_revision` | Stops control without refunding already dispatched usage |

Returning to the lead requires the original run/Session and uses the existing final-answer admission. Transfer retries retain immutable request receipts and cannot substitute another Session of the same role. Fixed error codes distinguish malformed input (422), forbidden identity (403), and unresolved usage/operations or revision conflicts (409); raw exception details are not published.

This transport does not create a member, interrupt its predecessor, discover all external effects, or prompt a receiver. The native host must still establish quiescence and reconcile provider/tool outcomes before using it. The capability remains unavailable in public UI, and production handoff is not enabled by this code change.

## Member admission before execution

Explicit `createNativeRoleHost` composition accepts an optional trusted `handoffAdmission` function. It runs in the official serial member-creation barrier, after the original task binding and guards are installed and before member model selection or publication. The callback receives the original parent, child, saved role reference, parent binding and a frozen child binding. It must return the authenticated management receipt: active state, matching controller role and revision, and the exact child run/Session binding. A wrong receipt or changed parent binding aborts admission without selecting a model. Ordinary Team composition omits the callback and retains its existing behavior.

This is a trusted host composition seam, not a model-selected callback or a JSON configuration switch. Formal `apply` does not automatically activate it. The host remains responsible for predecessor quiescence and external-effect reconciliation.

With `JOT_DSH_RUNTIME_MODULES` pointing to installed `0.2.0-rc.2` modules, run:

```sh
node --test packages/session-adapter/verification/native-task-handoff-runtime.mjs
```

The isolated actual SDK probe starts from an idle original lead, binds an existing task-step intent, transfers through the authenticated gateway before the member's first model request, rejects the old lead's workspace tool, verifies the member's shared-file receipt, settles calls, drains the official child and returns control to the original lead. It waits for the actual queued lead model request before checking idle; an earlier `whenIdle` observation alone does not prove future Team notifications have been processed. Calls use local scripted providers. This does not prove remote-effect discovery, production providers, automatic formal-host orchestration, or multi-hop crash recovery.

## Background web-operation closure barrier

A finished native tool call may only acknowledge a background operation. The closure reader therefore recognizes batch syntax for `universe_read_page` (`urls`), `universe_browse` and `universe_execute` (`inputs.items`), including one-item batches and JSON-encoded arguments. A returned message or finished turn does not establish operation completion.

The trusted JavaScript host can supply `reconcileOperations({sessionRef, callId, toolName, signal})` to `createNativeRoleHost` or formal `apply` configuration with native roles enabled. It is not a model tool, JSON setting or default network implementation. The observer must resolve the exact original operation under existing owner and permission checks. Its proof contains `session_ref`, `request_id` matching the call ID, a valid `web-` operation ID, positive integer `revision`, terminal `status`, explicit nonnegative integer `accepted_count`, and a complete `items` manifest with unique IDs/positions and terminal outcomes. Successful and failed terminal outcomes are closure facts, not business-success verdicts.

Missing observers, unresolved or mismatched proofs, truncated manifests and observer errors refuse closure with `native_child_remote_effects_unresolved`. The reader rechecks live Session state after observing operations. Ordinary nonbatch calls retain existing closure behavior. This is a trusted-host contract; it does not discover arbitrary external effects or implement remote cancellation. Other tool families require their own reconciliation before production enablement. At this closure-observer milestone, formal Handoff assembly and live operation acceptance remained pending; subsequent sections document later assembly and scripted-provider verification. Provider-side acceptance and production enablement remain gated on live reconciliation.

### Existing scoped leaf transport

Trusted native-role configuration can now set `nativeOperationOrigin` to the root HTTP origin of its existing loopback leaf bridge. The host queries `/v2/native/tool` using only `universe_get_state`, the original tool call as `request_id` and the exact child Session as execution scope. The existing leaf registry maps that Session to its runtime scope; OperationRegistry resolves the original call within that scope. The snapshot need not echo the DSH Session ID: the host carries scope from its authorized request, rather than reading identity from model arguments or display text.

Before and after each query the host checks the unchanged child binding and existing bridge authorization. Queries have a five-second timeout, reject redirects and remote/non-root endpoints, and retain only operation/item closure facts. A kind mismatch, transport failure, revoked authority or prior cancellation does not produce a proof. Configure either this transport or a custom `reconcileOperations` function, never both; native roles must be enabled. No endpoint is enabled by default, and no new browser action or MCP surface is added.

A real loopback HTTP test covers native creation, detachment, original-call lookup, both permission checks and the final existing closure request. Its server supplies synthetic operation state. Live provider operations, formal handoff assembly and production acceptance still require separate verification.

### Durable operation facts and recovery

Validated batch outcomes now travel in the existing authenticated child-closure proof as optional `remote_operations`. Each entry retains only the exact Session, original request ID, tool name, operation ID, revision, terminal aggregate status, explicit accepted count and terminal item IDs/positions/statuses. No tool inputs, remote text or URLs are included. The gateway validates the manifest before its existing transaction stores and hashes the full closure; conflicting retries cannot substitute different remote evidence. A rejected manifest does not release member capacity or undispatched holds.

Recovery reads the immutable closure and matches the remote entries against every recognized batch call in the exact stored log prefix, in addition to the existing log digest and identity checks. Missing, extra, duplicate, mismatched or unresolved entries block native publication. Older closures without remote evidence remain usable only when their recorded prefix contains no recognized batch calls. This is persisted trusted-host observation, not a signed provider receipt or proof of coverage for other tool families. Live operation acceptance and formal production Handoff remain pending.

## Original lead barrier during a host handoff

### Original Inbox protection and composed final-return lifecycle

Trusted hosts can opt into `nativeHandoff: { policyVersion, maxHops,
validateLog }` alongside `nativeRoles`, `nativeContinuation` and a configured
`workbenchModel`. Set `nativeDeferredHandoff` for model-created task intents.
`validateLog` must be the official isolated invariant validator described below.
These are server-side functions and policy values, never browser/model inputs.
The composed lifecycle creates one shared Inbox gate and supplies admission,
final return and recovery using the adapter's actual bridge and native services.
Mixing this option with manual handoff callbacks is rejected at startup.
The option remains absent by default; it does not enable a production profile.

The gate arms during the original lead's idle maintenance admission. The official
AgentLoop claims messages before `agent/pre-step`; at that hook the gate holds
the original driver before model dispatch while its child owns control. Native
Inbox changes and exact child publication metadata are permitted; unrelated
business-log changes block the boundary. Final return verifies child closure and
the authenticated management receipt before releasing that same driver. It does
not wait for its own `whenIdle`, create a replacement message or synthesize a
user wake. An idle protected lead still uses native maintenance.

Cancellation restores the original non-Goal message objects and IDs into the
official Inbox, deduplicating both pending queues. Goal-sourced prompts remain
owned by the official Goal driver. Cancellation does not wake the lead or resume
a paused Goal. A trusted exact-scope reconciliation can clear protection after a
verified return, or re-arm the same execution after explicit Goal resume. A new
binding, child, role or revision cannot redirect an existing gate. Detected
business-log corruption cannot be erased by re-arming it. Cancellation audits
the full tail from the original cut, including explicitly known held-turn
terminals and the original Goal's consecutive pause/resume/block revisions.
It never advances the cut past unchecked events. Binding revocation can abort
only the stored original local wait, without releasing permission. If the
Session or Inbox itself was replaced, original input is retained in memory
instead of being injected into the replacement; this is not durable recovery.

After a lost transfer response the live helper makes one read-only
`recover_return` check, requiring the original request, exact child proof and
immutable returned receipt. It does not blindly retry execution. Unconfirmed
return failures end the held wait, preserve input and retain a queryable blocked
gate for explicit reconciliation. They do not silently release model or tool
permission. The trusted lifecycle's gate exposes `statusFor` without user text.

```sh
node --test packages/session-adapter/verification/native-prestep-inbox-runtime.mjs packages/session-adapter/verification/native-task-inbox-return-runtime.mjs
```

The probes use the installed SDK, its real Goal/Inbox lifecycle and isolated
Gateway/SQLite with scripted local models. The normal vertical scenario starts
the composed configuration from an unpacked npm package. The uncertain-response
scenario verifies a single committed return and original user-message identities.
This is process-local hold/release evidence, not recovery from a hard kill after
claim but before message commitment. Lease succession, automatic multi-role
choice, live providers and production/browser acceptance remain separate work.
The composed option implements final return to the original lead, not a new
planner or a successor-role policy.

### Recover input claimed immediately before a process crash

The installed rc2 driver durably removes input from its Inbox before calling
`agent/pre-step`. A process killed there leaves neither pending input nor a
committed `user/message`. Official resume repairs the open turn with an
`interrupted` ending; it does not put that input back. A restored active Goal
starts disarmed, so restoring its phase is not execution authorization.

`createNativeClaimedInputRecoverySetup` is an optional trusted callback for
the official `agents.resume({ resumeSessionId, setup })` boundary. It runs
before Agent/Session publication and before other setup callbacks append
events. Supply the installed SDK's `Session` class, the actual `agents`, `sessions`, `query: sessionQuery` and
`projections: sessionProjections` services, the official isolated `validateLog`,
and two host functions: `authorize` must recheck the exact original owner's
run/Session/lease and return `{ authorized: true }`; `confirmReplaySafety` must
verify that the interrupted profile's pre-step hooks were side-effect free or
idempotent by original message identity and return `{ safe: true }`. Neither
function is supplied by a model or browser. Authorize the stored Session before
opening it as well. A service token or missing `user/message` alone is not proof
that arbitrary pre-step hooks are safe to replay.

The helper currently accepts only the Controller's explicit human `user`
source. Approval, question-reply, scheduling, internal-agent and other sources
are refused until their own replay/authorization contracts are implemented.
The policy callbacks receive frozen candidate IDs, targets and source metadata,
without message text.

The helper uses the official `sessionQuery.readSession` logical log, checks the
factory's `firstLiveSeq` and end-seed marker, and rechecks the source before
mutation. It does not add calls to deprecated synchronous live-Session event
readers. Candidate messages come from the official Inbox projection immediately
before each exact non-cancelled claim splice, using a real detached
`Session.create` instance and `snapshot(..., ['inbox'])`. Constructor end-seed
markers are checked and remain local; this is neither a structural stand-in
for a Session nor a registered Agent/writer. The original target, position,
ID and content are retained through insert-only native Inbox splices. Partial
prior restoration is deduplicated; conflicting content, later work, explicit
removal/replacement, started steps, inherited history and changed authority are
refused. Goal prompts remain owned by the Goal driver. Uncertain provider/tool
effects cannot be turned into successful or unexecuted work by this helper.

The callback only repairs input. It never sends a new prompt, wakes the driver,
resumes a Goal or grants model/tool permission. The SDK flushes setup changes
before publication. `setup.resultFor(agent)` reports fixed counts and
`execution_authorized: false`, without exposing user text. Compose it before the
host's existing setup, preserving the original preset/model/permission setup.
The ordinary HTTP Controller and default `apply` profile do not automatically
install it; audited preset/host wiring remains necessary. Do not replace the
original Controller just to install this callback.

```sh
node --test packages/session-adapter/verification/native-claimed-crash-runtime.mjs
```

The real subprocess probe kills only its own reported Node worker after both
durability flush and exact storage readback. Ordinary input and human input
alongside a Goal are restored and durable before the new Agent is announced.
No model runs until a subsequent explicit user continuation; each recovered
human ID then commits once, and the old Goal prompt is not replayed. A
second kill after durable restoration verifies the next resume inserts no
duplicate input. The two recovery scenarios use six separate processes in total.
A control confirms unmodified SDK resume leaves claimed input absent. Models and
authorization in these probes are local fixtures. This does not establish
Gateway lease succession, production preset policy, cross-process writer
exclusion, torn-write recovery, or a complete crash-and-final-return lifecycle.

### Optional final return after durable member closure

The natural-disposal observer waits only for the pending publication matching the member's exact original parent Agent and child Session. Host-owned async scope records the SDK's child identity before preparation awaits backend work; recovery binds the validated original reservation identity before reading and publishing its durable evidence. An already-saved publication remains a pure replay. This preserves that member's roster-publication ordering without coupling closure to another slow spawn, including another member under the same parent. Host shutdown still waits for all pending spawns before removing the admission hooks. This wait is not a global quiescence guarantee or a lock against later publications.

The official continuation runtime already owns natural child settlement and release. The host does not force a drain on each idle event. Its existing deferred `session/disposed` observer reads back the exact detached child's log and obtains the original gateway closure receipt. Only then can the trusted `onMemberClosed` hook run. Failed hook attempts can be retried from that cached closure without another child creation or another closure write. Host shutdown skips new notifications, cancels in-flight notification signals and waits for those promises.

Formal `apply` accepts an optional trusted `handoffReturn` function only with native roles and an explicit `handoffAdmission`. `createNativeHandoffReturn` provides a final-return implementation: it verifies the exact closed run/Session/role, fetches the immutable handoff-purpose source, compares the full stored log and operation facts, waits outside the lead's own tool for native idle, and enters the existing maintenance barrier. The authenticated management read must still bind the controller to that exact child execution. A deterministic return request then targets the original lead run/Session; current policy, lease, model-usage and operation checks remain gateway-owned. Changed or malformed routes and same-role alternate executions are refused. A post-commit cancellation cannot undo the transfer; an explicit retry uses the same request identity and original receipt.

This is a final return: the current gateway state machine closes the chain when it returns to the lead. A trusted orchestrator must choose a successor instead when a multi-role route is still in progress. This hook does not supply that choice or complete all pending intents. The live notification hook has no durable outbox; recovery of an already committed closure on root reattachment is described below. Manual callbacks without a shared Inbox gate can still let Team notices wake lead planning before return; use the composed lifecycle above for the tested hold/release ordering. Production lifecycle acceptance remains open.

```sh
node --test packages/session-adapter/verification/native-task-auto-return-runtime.mjs
```

That isolated scripted-model scenario observes natural child release, committed closure, automatic return and restored original lead permission. It does not manually drain the child or issue the return transfer. It does not establish that the first lead planning model call after a Team notice starts only after return, nor does it cover a process kill during a provider-side effect.

### Recover a closed member after host replacement

An explicit trusted `handoffRecovery` callback can be configured alongside native roles and handoff admission. Formal root Session attachment calls it before restoring deferred task intents. A blocked or malformed recovery result keeps further prompts and member dispatch blocked; reattachment can retry the same original scope. The option is host code, not a model tool or JSON activation switch, and remains absent by default.

The existing authenticated handoff transport accepts the read-only `recover_return` action with an empty request. In one original transaction it checks the current controller revision and exact native execution, reads the latest immutable child closure and verifies its stored digest. A pending final return is derived from those existing facts; there is no second task plan or pending-state table. A returned result additionally requires the deterministic original request ID, matching request digest and exact immutable returned response. Stopped handoffs remain blocked. Original owner, Session, task, policy and worker-lease checks are retained; the read grants no execution rights.

`createNativeHandoffRecovery` checks the same original parent binding and inactive-Goal boundary, then enters native maintenance. It rechecks the recovery snapshot, reads the closed child's complete durable log twice with no suffix, verifies the original hash and remote-operation proofs, and checks both Agent and Session registries for residency or draining. The current protocol accepts only fresh, unseeded children with zero inherited events. It never resumes the child. The official inbox projection is rebuilt on a new immutable read view, selecting only inbox output so absent unrelated domain views do not invalidate it.

Supply `validateLog` from `createNativeInvariantReplay({Context, Service, InvariantRegistry, sessionInvariant})`, using the installed official Cordis and DSH session-invariant packages. This helper loads the official package-owned invariant in an isolated context whose only Session service exposes the read-only log. It has no Agent, planner, model, tools or writer. Validation must succeed on each read; an approximate local fold is not treated as the official relation invariant. Pass the original `sessions`, `registry`, `persistence` and `projections` services to the recovery helper as well. The independent packed-module check covers both helpers.

After proof validation the host reads the same recovery state again and uses the existing revision-CAS transfer with the original stable request ID. A committed transfer followed by a lost response is confirmed on reattachment through its original immutable receipt, without a second transfer or another model call. This is only final-return policy: do not enable it for a closed predecessor that should hand control to another member instead.

```sh
node --test packages/session-adapter/verification/native-task-return-recovery-runtime.mjs packages/session-adapter/verification/native-offline-invariant-runtime.mjs
```

The actual installed-SDK recovery probe disposes one host and attaches the original lead in a new host while the member remains absent. It verifies the original file receipt, unchanged model-call counts, one child and one final-return receipt. It retains the same valid lease; it does not prove worker-generation succession, hard-kill recovery before closure, cross-process writer isolation or production providers. The separate Inbox probe above covers process-local message release order. Two matching log reads are a race check, not a write lock. A changed lease or unresolved original source must remain blocked until separately authorized recovery is implemented.

### Deferred model-callable handoff

Formal `apply` can explicitly enable `nativeDeferredHandoff:true` together with native roles and a trusted `handoffAdmission` function. The ordinary Team path remains unchanged when this option is absent. Model `tasks.delegate` first prepares the existing immutable intent and returns `{runtime:'native_team',state:'pending',request_id,subtask_id,execution_authorized:false}`. It does not wait for its own running lead turn to become idle.

The host watches the original native `agent/status` idle event and starts at most one queued transition per wake. Before spawning it checks exact live Agent/binding, cancellation, existing budget authority, the original paginated journal and the unchanged plan. It then uses the same request ID and native host admission path. Duplicate submissions with changed contents conflict. Already reserved rows, missing/changed plans and revoked authority become blocked local observations rather than new executions. The trusted `jot-native-task-scheduler/result` event reports published, blocked or cancelled state; it never sends raw exception text or grants model authority. Host disposal removes the observer, aborts pending/active dispatch and waits for the active promises before disposing the role host.

The queue is process-local coordination over durable original intents. Trusted root Session reattachment now restores pending records from that journal. At this scheduler milestone, automatic uncertain-publication recovery and active-member reattachment were still pending; later sections document role-transition admission and scripted multi-role verification. The SDK verification below uses a scripted model and explicitly returns control through the existing management API after child closure; it is not production or complete autonomous task acceptance.

A scheduler-local `cancelled` result or local abort does not itself cancel or tombstone the durable original task intent. On root reattachment, a pending intent can be restored if gateway task and Goal authority still permits it. Persistent task cancellation must be recorded through the owner-checked gateway cancellation or Goal-stop path.

```sh
node --test packages/session-adapter/verification/native-task-deferred-handoff-runtime.mjs
```

### Original intent restoration

When deferred handoff is configured, formal Session creation first attaches the existing workbench identity. Only a trusted context whose task root matches that exact run is eligible for scheduler restoration; chat contexts and member bindings are not treated as task roots. The scheduler reads all journal pages and checks cancellation, live Agent/binding, budget/Goal authority and frozen plans before changing the queue. A failed page cannot partially enqueue work. A paused Goal returns `inactive` without reading or restarting its intents.

Pending entries retain their original request IDs and launch through the normal native admission after idle. Reserved entries are queried through the existing `native-child-request` lookup with the exact digest of the original intent and spawn request. A matching immutable publication restores only the `published` observation; no member is started or recreated. A reservation without publication remains `blocked` for reconciliation. Conflicting identities, digests or publication IDs refuse recovery. This does not prove that a recorded published member is currently resident or that its external effects completed.

The Session response includes `native_dispatch_recovery` with `restored`, `inactive` or `blocked` state when applicable. Dispatch-recovery failures do not hide the original Session or reveal exception text; subsequent prompts still pass the original workbench permission checks. Host shutdown cancels and drains both recovery and active dispatch. The new-host SDK probe reads a preexisting SQLite intent through actual authenticated HTTP without a new lead delegation/model-planning turn. It does not simulate a process kill during an external side effect.

```sh
node --test packages/session-adapter/verification/native-task-deferred-restore-runtime.mjs
```

The trusted host can read `/internal/v1/workbench/native-task-intents` under the same original run, Session and worker lease. Optional `limit` (1–50, default 20) and `after_request_id` page the existing immutable journal by creation time and request ID. The cursor must belong to that original owner/run. Each item returns its original plan, `pending` or `reserved` state and `execution_authorized:false`; a reservation is never treated as completed publication.

Reads recheck the current active original task, role grant and policy version. A changed unreserved step refuses the read instead of silently rewriting its frozen assignment. Already reserved rows remain historical scheduling facts; this endpoint does not reopen them, grant model/tool authority, select another role or resume a paused task. Existing reservation/admission checks are still required at execution time. Enumeration is a prerequisite for deferred host scheduling; automatic scheduling is not enabled by this endpoint.

The transition now acquires the original Agent's native `runMaintenance` phase. Public `idle` status alone does not establish phase ownership. Missing native maintenance support or an already owned phase refuses admission; there is no fallback to an ordinary idle check. Log capture inside the owned phase does not await that maintenance task's own `whenIdle()` promise. The operation callback receives the combined native/request cancellation signal, which the admission factory propagates to its management and predecessor-evidence requests.

New user input during maintenance stays in the original native inbox. Changed input or Session evidence refuses the handoff rather than transferring a stale source. When maintenance exits, the native loop may wake that queued input. This does not roll back a management transfer that already committed; that case still requires receipt reconciliation. A busy lead is refused, not automatically scheduled for later.

`withNativeHandoffBarrier(input, operation)` is a trusted-host transition helper. It requires the exact resident original Agent to be idle before entering, rejects pending native inbox messages, and installs temporary tool and Session-local model gates. It reads back the original persistent log and reconciles recognized batch calls using the same closure rules. Before, between (through the supplied check function) and after management requests, the caller can verify that the original Agent, Session sequence, residency and inbox remain unchanged. All temporary gates unwind on success, cancellation and failure.

The helper does not wait for a running lead from its own tool callback; that would wait on itself. An idle fresh lead may have only official Goal metadata and no completed turn. The reader allows that initialization state while still rejecting unfinished execution, missing tool outcomes and unresolved background batches. Member closure continues to require a completed turn and native detachment.

Formal `apply` now accepts the existing trusted `handoffAdmission` function when native roles are enabled. This function is host code, not a JSON/model switch. It still runs before member model selection and publication and must return the exact authenticated controller/binding receipt. The helper does not choose roles, call the management API itself, save a lead checkpoint, reverse a committed transfer, or schedule deferred handoff intents. A failure after a management commit requires reading its original immutable receipt, rather than retrying as a new child. At this admission milestone, deferred scheduling and subsequent-role transitions were not yet integrated; later sections document those additions and their verification boundaries. Crash recovery and production UI remain pending.

The actual installed-SDK isolated handoff probe now uses this lead barrier around authenticated start/transfer. Its model is scripted; it is not a live provider or production test.

## Initial handoff admission through formal HTTP

`createNativeHandoffAdmission` assembles the existing lead barrier and authenticated handoff management transport for original-lead-to-member and verified closed-member transitions. A trusted host supplies the existing bridge, native registry/persistence/projections, frozen collaboration policy version, configured model route and authorized hop limit. Its returned function can be passed to formal `apply` as `handoffAdmission`. It is host code; no model/user argument can replace these configuration fields. Default setup remains unchanged.

The helper starts original control and transfers to the exact prepared child run/Session before member model selection. Management request IDs are deterministically derived from the original execution identities, so retrying cannot silently replace a receiver. Start and transfer receipts must have the exact expected active phase, revisions and concrete execution binding. The original gateway still validates owner, lease, collaboration, budgets and observed operations. Busy leads are refused; this helper does not implement deferred scheduling, later-member selection or automatic return.

The installed-SDK `verification/native-task-handoff-http-runtime.mjs` now exercises this reusable module through the real SessionController, formal adapter HTTP member creation, real gateway and isolated SQLite state. It rejects unauthenticated and unbound requests, replays the same member request without another execution, and refuses changed content under the same request ID. Each actual model body checks that its original budget attempt is in flight; the member produces an original-task file receipt. The test explicitly drains the native child, observes the formal host's durable closure, waits for the real lead model call to settle and then returns control through management. This is formal single-member evidence with a scripted provider; draining and return are still trusted orchestration in the probe. It is not automatic production task completion, multi-hop routing or external browser acceptance.

## Subsequent member transitions

The trusted host may supply `previousExecutionFor` to return the exact preceding Agent, run ID and saved role ID for a subsequent admission. That descriptor is copied before asynchronous checks. The predecessor must be idle and detached. The host retrieves its immutable closure through the existing authenticated `native-child-source` route with `purpose: handoff`, verifies its full stored log prefix and rechecks the complete closure facts against the current detached log. A resumed or changed predecessor cannot provide this boundary.

A handoff state read now includes the immutable current `binding` (or null where no binding exists). Source run and Session must match that actual controller binding; a different closed instance of the same role is insufficient. Transfer uses the current revision and exact successor. A replay whose receiver already controls the task must still match its exact binding and original immutable management request. Role choice remains the original planner/trusted host's responsibility; the module does not infer a new role or create a new receiver to retry an unknown outcome.

The handoff-only source purpose is an accounting read restricted to the original owner, task root, parent Session and current lease. It can read a completed predecessor's closure without granting activation. Default source reads and cold activation retain their original running-assignment requirements. This prevents legitimate step completion from blocking the next role while preserving revocation of the old execution. No new MCP tool or public route was added.

The formal HTTP multi-hop probe executes two different saved roles in one workspace. The first writes a file and its step is marked complete through the existing task service with the real file receipt. The second actually reads that file, records its own read/write receipts and closes its separate native execution. Both closures, exact controller revisions and shared budget settlement are checked before control returns to the original lead. Models are scripted, upload/archive services are inert, and the probe explicitly schedules and drains members. Automatic scheduling, automatic final acceptance, hard-exit recovery, live external effects and production remain separate unfinished checks.

## Formal Controller claimed-input recovery

This optional integration retains the original official SessionController,
its model selection and preset mounting. The pinned rc.2 Controller does not
expose a host setup callback for Remote create/resume. Jot supplies a small,
explicit compatibility delta in AgentLoop (hook protocol 2): serial
`agent/before-setup` and `agent/after-setup` events around the original setup,
inside the original maintenance/rollback boundary. The second check completes
before the original setup's synchronous commit and registry publication.
This is a Jot extension, not an existing upstream API. No private Controller
method, replacement factory, second planner or runtime monkey patch is used.

Prepare an **isolated** package from the exact installed distribution:

```sh
node packages/session-adapter/scripts/prepare-dsh-pre-setup.mjs /absolute/source/dsh-agent-loop /absolute/new/compatibility-package
```

The script verifies package name, exact `0.2.0-rc.2` version and the pinned
15-file SHA-256 manifest for every copied upstream file, including the package
manifest and secondary entry points, then applies the two-file delta. It refuses
existing/overlapping targets, source symlinks and source drift. It neither
installs dependencies nor activates a profile. Compose the copied package with
its normal installed dependencies in an isolated host first. Never overwrite a
running runtime. A version or artifact change requires fresh review.
Protocol 1 copies are not accepted by the current composer: prepare a new
protocol 2 copy from the unmodified pinned upstream package. Existing source
receipts are not silently migrated or rewritten when code/profile hashes change.

`createNativeReplayProfile` requires absolute artifact paths, expected SHA-256
hashes, an audit ID, an exact preset ID (or explicitly no preset), and a trusted
`verifyComposition` callback. Include all loaded host plugins, recovery modules,
configuration and preset sources relevant to pre-step effects in that audit.
Use immutable, versioned, operator-owned deployment directories outside Agent
workspaces. Hashes establish continuity, not safety. The callback must independently verify
that these are the reviewed loaded artifacts and that pre-step replay has no
unresolved side effects. A permissive callback is not production acceptance.
The callback receives the exact host-only `agent` and `phase`. In `prepared`,
verify the reviewed standing Registry generation and loaded sources; the Agent
has not mounted its preset yet. In `bound`, read back the Agent's actual preset,
standing scope, effective capabilities and model route. Both checks must return
the same approved profile fingerprint. Pass the explicit preset ID in Session
requests when the Registry has a default; a declared no-preset profile cannot
silently adopt that default. Idempotent resident-Agent adoption also checks its
bound source and original provenance before calling the Controller.

`createNativeReplayProvenance({root})` stores write-once, synced host receipts
outside the conversation log and model context. Configure an operator-owned
directory outside all Agent workspaces; enforce the host's directory ACLs.
Complete records are written and synced in unique temporary files, then
published by an atomic, non-overwriting hard link. The filesystem must support
this operation; unsupported storage fails closed. POSIX directory metadata is
synced; Windows crash durability and ACLs require platform acceptance. Abandoned
temporary files are never interpreted as receipts and do not block later writes;
remove them only during an operator-controlled offline cleanup. No automatic
deletion of live records is implemented.
Receipts bind Session ID and creation timestamp to the reviewed profile and a
hash of the original Gateway task/owner/lease scope. They grant no permissions.
Their lookup key hashes both fields, so an abandoned pre-publication Session
incarnation cannot poison a later fresh incarnation. Reads verify the opened
file's identity and use that handle. Missing, damaged, changed or conflicting
receipts fail closed. DSH rc.2 rejects
unknown non-ignorable events, so Jot does not append custom provenance events or
change the official Session format. Back up this directory with Session storage.

Enable only via trusted host code:

```js
nativeClaimedInputRecovery: {Session, validateLog, profile, provenance}
```

The adapter requires native continuation, a budget model and authenticated
Workbench access. Every Session creation in this opt-in profile requires an
exact task-root run/Session and current fenced execution lease. Gateway checks
occur **before** the original Controller may read stored Session content, and
again before restoration. Child runs, ordinary chats, different task versions,
leases, capability epochs, objectives and source profiles are not adopted.
Worker-generation succession is deliberately not implemented by this helper.

Inside the unpublished setup, Goal identity, phase and objective are read from
the official pure Goal projection: `GoalService.get` requires a live published
Agent and must not be used here. The original setup remains in control. Recovery
preserves only original eligible human messages, including the actual Controller
RPC source `{kind:'user', rpcId:...}`. The source-map key `user-rpc` is not its
runtime discriminator. Goal rounds and internal sources are not human replay.
Both a newly appended and an already durable neutral `session/end-seed` marker
are supported; a rejected setup may have flushed that marker before retry.

Creation/recovery has a 30-second cancellation deadline, independent of task
turn/token budgets. Request cancellation and host disposal abort waiting policy
callbacks. The hook binds that cancellation to the original factory's own
lifecycle AbortController until setup, suffix persistence and publication end.
It does not abandon a pending storage append. After that append settles,
cancellation prevents publication. Already durable metadata or restored Inbox
records stay in the append-only log; cancellation does not truncate history or
promise zero disk writes. A retry must preserve that exact prefix and consume
original input only once. If a Controller read has not settled, a disposed
composer retains its rejection fence until that original operation ends, rather
than permitting a late publication. Reads themselves may remain outstanding
where the official API offers no cancellation; their results cannot mutate the
closed recovery. Failures expose only a fixed error response; task prompts remain
blocked. No restoration sends a message, activates a Goal, executes a tool or
calls a model. Existing default profiles remain unchanged.

The actual installed-SDK probe uses the original Controller over adapter HTTP,
real Gateway/SQLite authorization and budget accounting, and the isolated
compatibility copy. It kills only its own worker after durable native claim and
before any model call. New workers reject a wrong lease and changed profile
without publication, then restore the original RPC/message IDs successfully.
Goal remains disarmed and model calls stay zero until an explicit continuation.
Official queue semantics consume the restored message and new continuation in
two turns, each once. A second case uses the actual official Registry and Loader
with a local deterministic preset: it checks exact scoped tool identity, root
tool isolation, mounted instructions, original model selection, one successful
tool and one permission-denied call. It rejects an unreviewed generation between
setup and publication, including a first-create failure followed by a retry.
After restart, the new host checks its own actual standing-scope identity against
the reviewed source fingerprint; native JavaScript scope objects are not
serialized across processes. The preset case has three scripted model calls
after explicit continuation because its first turn includes a tool step.
Separate factory cases cancel while the rc.2 append API is pending and just
after it completes, inspect the durable suffix and retry the same Session ID
without duplicate title events or a model call. Storage is a real rc.2 JSONL
backend with a test-only timing wrapper, not a synthetic persistence result.
These are mechanism tests; their self-measured fixture hashes are not an
operator-approved production manifest. Production presets, live providers,
lease succession, concurrent writers and
external side-effect recovery remain separate acceptance work.

```sh
node --experimental-strip-types --test packages/session-adapter/verification/native-claimed-controller-runtime.mjs
```

One parallel run of the older model-callable delegation probe observed one
child model call where two were expected. Its historical failure lacks the
child event/budget evidence needed to establish a cause. Isolated diagnostics
and a later complete run passed; that does not establish a fix. The original
assertion is retained, and a future mismatch now preserves the synthetic
Session log, budget rows and isolated database for diagnosis. This remains an
open verification issue, separate from the default-off recovery integration.
