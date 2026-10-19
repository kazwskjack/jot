# Original Git admission and execution history

This continues the [Git HTTP/workbench workflow](../superpowers/plans/2026-10-19-git-index-http-workflow.md)
and [original execution disposition](2026-10-19-git-execution-disposition.md).
It does not complete the Git capability or the full PilotDeck/portable Chat/Work
release. The production website is outside this change.

## Implemented boundary

The original `GitIndexExecutions.admit` operation is synchronous and requires an
existing SQL transaction. It records the exact approved request and an immutable
accepted receipt together. It neither acquires a Worker lease nor touches the
repository index. A failed caller acknowledgement rolls both records back.

`perform` accepts only an original execution ID and retrieves its stored request,
review version and review digest. It uses the existing executor, approval fence,
binding, physical evidence, lease and recovery journal. A cached acceptance does
not renew cancelled approval. Internal/native executions without original
admission cannot be silently adopted as workbench requests.

The original direct execution contract remains available to its existing trusted
callers. Neither this internal `perform` method nor `admit` is mounted as a write
route, native tool or background scheduler in this increment.

## Available history API

| Read | Meaning |
| --- | --- |
| `GET /v1/projects/{projectId}/git/admissions/{requestId}` | The exact immutable original acceptance. It remains historical after cancellation, execution or disposition. |
| `GET /v1/projects/{projectId}/git/executions/{executionId}` | The current journal result of an originally admitted execution, never a replay command. |

Both reads require the current original project owner, reject query selectors,
return `private, no-store` and use the original BFF's fixed owner and no-store
request behavior. Missing or unrelated requests return 404. Missing authentication
returns 401. Corrupt evidence returns a generic unavailable response without host
paths, SQL messages or other internals. A project transferred to another owner
does not transfer its former owner's execution history.

Acceptance and current result have separate shared contracts in OpenAPI JSON,
YAML, the operation manifest, event definitions and TypeScript. The workbench
client has separate `gitAcceptance` and `gitExecution` reads with cancellation.
No execution button has been enabled by these client methods.

`pending` means no recorded physical preparation/dispatch; it is not a promise
that a producer is running. `unknown` preserves unresolved physical evidence and
does not mean failed or safe to retry. `applied` requires the original immutable
outcome. Explicit original-owner disposition has `not_dispatched` or
`abandoned_unknown` and its original disposition ID. No history response grants
execution authority or performs physical reconciliation.

## Verification coverage

- Actual isolated Git repositories and SQLite journals: original stage
  publication, replay, database reopen and unchanged index bytes after repeated
  history reads. An actual unborn repository verifies that an absent original
  index is represented as `before_index_sha256: null`, not a fabricated hash.
- Actual child-process termination before and after admission transaction commit:
  either neither record exists or both survive. No index locks, dispatch or lease
  appear merely because a request was admitted. Retrying preserves the original
  request and publishes its effect once through the original executor.
- Caller acknowledgement rollback; current approval cancellation; explicit
  not-dispatched disposition; owner revocation and transfer; no adoption of
  internal direct executions; corrupted receipt and original request digests.
- Physical publication followed by failed outcome persistence remains `unknown`
  through restart and repeated HTTP reads. Reads do not recover or redispatch it.
- Real BFF and Gateway handlers preserve the original receipt while fixing owner
  server-side. Shared schema validation rejects mixed states, authority claims,
  paths in acceptance, unsafe result paths and host selectors. Client cancellation
  retains the existing request deadline wrapper.

Release verification for this increment:

- Complete Gateway suite: 2,030 tests, 2,023 passing, seven existing conditional
  skips, zero failures. The late nullable-index schema/type correction also had
  its own RED/GREEN reproduction and the final all-Git/contracts run below.
- Final Git/contracts group: 117 passing, zero skips or failures, including the
  original direct executor's approval, crash, binding, lease and cleanup cases.
- Standalone runtime: 67 passing; complete workbench/Jot UI group: 251 passing.
- Gateway typecheck and Windows Gateway/Vite builds passed. Both final builds
  were repeated after the complete Gateway process terminated, keeping template
  generation outside the running fixture suite.
- Six public-scanner regressions and Brain link validation passed. The source
  review scanned 1,106 files without a finding; staged/history review remains a
  separate publication check with the original unchanged policy.

These gates verify this increment, not the remaining workspace/producer/UI
activation or full product parity.

## Remaining execution wiring

1. Connect original workspace coordination across Agent turns, shared-workspace
   writers and checkpoint restore before permitting physical UI dispatch. A
   Git-only Worker lease does not prove this coordination. Preserve native
   Session/run/role permissions and cancellation; DSH remains the planner.
2. Mount original atomic HTTP admission only with that real producer lifecycle.
   Persist original producer facts for known failures, interruption and unknown
   effects. Do not auto-poll/retry every pending internal execution.
3. Add original request recovery and current-result/disposition UI to the actual
   mobile workbench, then exercise stage/unstage, lost acknowledgement, process
   loss, drain and cancellation end to end.
4. Continue commit, destructive, revert and separately authorized remote
   operations. Keep the full capability ledger open until its own acceptance
   requirements are satisfied.
