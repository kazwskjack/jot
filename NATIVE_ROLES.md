# Native role integration

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

On Windows with Node 24, the current native-dispatch release passed 173 Session adapter tests, 31 portable runtime tests and five actual SDK runtime scenarios without skips. The web build passed. The prior focused gateway check passed 40 tests; its most recent full check passed 945 tests with six POSIX/Office cases skipped. Gateway source is unchanged by this release. These are local release checks with scripted model responses, not external-provider or production acceptance.

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

The module requires a trusted host authorizer on every operation, including replay. That authorizer must check the original task, role policy, worker lease and budget; controller checks must be composed inside the host's original execution admission transaction. This module does not dispatch models/tools, reclaim expired leases or prove task acceptance. Its authenticated management transport is described below; native-host orchestration and UI remain pending. Swarm/Handoff execution remains unavailable until that integration and actual lifecycle acceptance are implemented. Root planning and final-answer responsibility stay with DSH.

`task-handoff-host.ts` provides the task-bound management adapter. It binds the original owner/root run, exact collaboration policy and worker lease, reuses original task/role validation, and previews the configured model budget without reserving or spending it. Starting or transferring waits for all related model usage to be settled; pending or unknown usage blocks the transition. Stop can close management control while usage is pending without refunding it. Policy changes, worker replacement and occurrence cancellation reject further control changes.

This adapter is still not an execution grant or a public route. A role may have multiple native Sessions: actual transfer must additionally bind one concrete execution identity, settle prior effects and compose its controller revision with each operation's original admission. Those native-host and UI steps remain pending; a role name alone cannot authorize a Session.

The task-bound adapter now includes `bindExecution` and `assertExecution` for one exact run/Session per controller revision. Binding validates the original Session registry, current role and native root lineage, worker lease and original run/assignment permissions. Stored bindings cannot be updated or deleted. Another execution of the same saved role cannot inherit or replace a binding. A transfer or stop invalidates the old revision.

The original gateway tool guard and workspace operation transactions now check the current handoff controller and exact execution binding when a handoff record exists. Unbound or non-controller instances are rejected before new workspace effects, including calls from another native Session of the same role. Stopped control denies tools; returning to the lead permits only the original lead run to use the finalization path. Ordinary tasks without a handoff record retain their existing behavior. Planning and accounting reads remain separate.

The operation fence rechecks the frozen worker lease and exact collaboration policy. Older control records without those frozen fields fail closed; they are not silently upgraded to new authority. Only the authenticated internal management transport exposes control changes; no model tool or public UI does. Native-host transfer, external-effect reconciliation and UI enablement remain pending. This gateway check does not stop already dispatched remote effects or prove their outcome; verify those before activating the receiver. DSH planning/final-answer behavior must remain separate from step execution control.

Handoff management also checks the original worker's persisted web-operation cursor observations. The worker records the validated operation status and whether every accepted item has a known terminal outcome, in the same transaction as its revision and activity event. A running/unknown operation, terminal aggregate with unresolved items, missing outcome or truncated item set prevents a transfer even after model usage has settled. Stale snapshots do not replace newer facts.

The database migration leaves historical observations unresolved; it does not infer completion from an old cursor or display message. They need a newer validated operation observation. This closes the barrier for operations already observed by the original worker. It does not establish discovery of every remote effect, cancel an external operation or replace provider-side reconciliation. Native-host orchestration and production Handoff remain gated on those additional checks.

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

Missing observers, unresolved or mismatched proofs, truncated manifests and observer errors refuse closure with `native_child_remote_effects_unresolved`. The reader rechecks live Session state after observing operations. Ordinary nonbatch calls retain existing closure behavior. This is a trusted-host contract; it does not persist the proof itself, discover arbitrary external effects or implement remote cancellation. Other tool families require their own reconciliation before production enablement. Formal Handoff assembly, live operation receipts and production acceptance remain pending.

### Existing scoped leaf transport

Trusted native-role configuration can now set `nativeOperationOrigin` to the root HTTP origin of its existing loopback leaf bridge. The host queries `/v2/native/tool` using only `universe_get_state`, the original tool call as `request_id` and the exact child Session as execution scope. The existing leaf registry maps that Session to its runtime scope; OperationRegistry resolves the original call within that scope. The snapshot need not echo the DSH Session ID: the host carries scope from its authorized request, rather than reading identity from model arguments or display text.

Before and after each query the host checks the unchanged child binding and existing bridge authorization. Queries have a five-second timeout, reject redirects and remote/non-root endpoints, and retain only operation/item closure facts. A kind mismatch, transport failure, revoked authority or prior cancellation does not produce a proof. Configure either this transport or a custom `reconcileOperations` function, never both; native roles must be enabled. No endpoint is enabled by default, and no new browser action or MCP surface is added.

A real loopback HTTP test covers native creation, detachment, original-call lookup, both permission checks and the final existing closure request. Its server supplies synthetic operation state. Live provider operations, durable remote-proof storage, formal handoff assembly and production acceptance still require separate verification.
