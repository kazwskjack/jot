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

The model-callable `tasks.delegate` path is not yet switched to this native Team host. Full Handoff/fork/Swarm behavior and business acceptance remain separate work. Enabling a host flag does not complete these paths. Keep the integration off until your required path has been wired and accepted.

## Local release checks

On Windows with Node 24, this change passed 163 Session adapter tests, 31 portable runtime tests, 105 workbench UI tests and 934 gateway tests. Six gateway cases were skipped for unavailable POSIX/Office conditions. Both web and gateway builds passed, and the packed adapter imported independently. These are local release checks, not external-provider or production acceptance.

## Native delegation intent journal

`NativeTaskIntents` and the authenticated internal `native-task-intent` endpoint prepare an immutable assignment plan from a lead's existing task step. They bind the request to the owner, current occurrence, role grant and step revision. The endpoint also validates the original worker fence. Retries revalidate permission and return the same plan; changed arguments conflict, and edited steps or revoked grants reject replay.

Planning does not reserve a child, enqueue the legacy mailbox, change a step to running, invoke a model or prove completion. `execution_authorized: false` is intentional. The model-callable `tasks.delegate` path still uses the existing implementation until native publication dispatch and complete host integration are verified together. Intent-to-reservation binding and member assignment/evidence guards are now implemented in the gateway. Do not call both dispatch paths for one request.


## Bound member assignments and evidence

When a reservation matches a saved native task intent, the gateway validates the role/policy and step revision, verifies prerequisite evidence, transitions the step to running through the original task service and saves its frozen assignment in the same transaction as the reservation. A failed reservation write rolls back the transition. Retrying cannot consume another slot or change the assignment. A host with a matching plan cannot omit the assignment service.

Child model/tool admission rechecks the current running step and revision as well as the original native owner, role, parent lease and budget. Editing or blocking a step revokes its member's new execution. Cold activations retain the same assignment; they do not reset task progress or grant fresh permission.

Actual member workspace operations return persisted execution receipts. Assigned-member receipts can be verified against the original owner/task/occurrence and result hash. Generic native roles without a task assignment do not contribute parent-task evidence. Receipts remain historical evidence after a step changes; they do not keep execution authority alive or prove that acceptance criteria were met. The member cannot update the parent task ledger; the lead must review materials and update the original step.

These gateway boundaries do not yet switch the model-callable dispatcher to native Team. Keep native flags off until the full dispatch/recovery path and required production tools are accepted together.
