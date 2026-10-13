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
