# Project discovery and reviewed work cycles

This is the remaining Always-on capability in the approved full PilotDeck scope,
not a replacement for ordinary native Goal or existing persistent tasks. DSH
remains the only planner and native executor. This plan does not authorize
background work against user projects before their owners configure it.

## Source review and current gap

Reference baseline: OpenBMB/PilotDeck `783499ffdb2d501bf590b2e035acd027a882df10`,
AGPL-3.0. This review traced named call paths below, not every upstream line or
production behavior. Reused upstream code requires its license obligations;
the Jot gate implementation is independently written for existing Jot boundaries.

| Upstream mechanism | Reviewed source/symbol | Jot integration requirement |
| --- | --- | --- |
| Lifecycle | `runtime/AlwaysOnRuntime.ts`, runtime construction/bind/start/stop | Existing Worker lifecycle, one shutdown signal; no second process pool/planner. |
| Trigger and dormancy | `DiscoveryScheduler.runTickOnce/tick`, `SignalWatcher` | Owner/project source revisions, idle/cooldown gates, debounce and durable wake signal; self-generated files do not wake discovery. |
| Busy/presence | `DiscoveryGates.evaluateAlwaysOnDiscoveryGates`, channel leases | Actual original-run/native occupancy is authoritative; absent/stale channel presence never proves idle or authorization. |
| Reservation | `DiscoveryScheduler.tick`, `DiscoveryFire.acquireDiscoveryLock` | Existing database transaction plus immutable occurrence identity; never infer no previous call from a stale PID/file/heartbeat. |
| Planning/execution/report | `DiscoveryFire.run/rerunPlan`, scoped run contexts | Original DSH role/task runs, inherited budgets and native Goal; distinct plan, execution and report facts. |
| Work cycles | `ensureActiveWorkCycle`, `WorkCycleStore` | One owned active cycle with frozen base and explicit source revision, reusable isolated workspace, no competing task status store. |
| Workspace isolation | `WorkspaceProviderRegistry`, Git worktree/snapshot providers | Only reviewed owned paths, bounded copies and exact Git state; private configuration/credentials excluded. |
| Plan and report contracts | `PlanContract`, `ReportContract` | Structured source-backed proposal, verification evidence and dedupe identity; missing/degraded report cannot establish task completion. |
| Apply | `createApplyHandler`, `runApplyPhase`, `WorkspaceApply` | Owner reviews frozen diff and confirms exact base/version; conflict or uncertain write holds, no automatic live-project mutation. |

Upstream discovery uses unattended `bypassPermissions` session overrides and
permits an empty fresh channel-lease list. Those are **not** Jot permission or
idle proofs and will not be transplanted. DSH high reasoning, existing Gateway
ownership, permissions, original leases and unknown-accounting holds stay intact.

Current Jot `persistent-tasks/scheduler.ts:maintainWorkbench` admits configured
tasks only after execution readiness. `PersistentTaskService` owns triggers,
occurrences, idempotency and pause/stop; `WorkbenchService` owns scoped roles,
memory and run bindings. The Gateway currently has no project discovery scheduler,
work-cycle record, isolated-workspace provider or reviewed cycle apply path.
Session checkpoints are native history recovery, not project file snapshots.
No existing green recovery test proves these missing capabilities.

The initial audit found a concrete contract gap before continuous admission:
`PersistentTaskService.create` currently defaults `max_runs` to 100 and accepts
only 1–10000. That existing task limit is not an unlimited discovery policy.
Do not silently create such a task and claim continuous/unlimited operation.
Extend the original task run-limit contract, migrations, all admission/readiness
consumers, pause/stop and UI to an explicit owner-selected unlimited form before
using it for standing discovery. This is separate from existing unlimited model
budgets and must not be implemented as a new competing quota ledger.

That prerequisite now has an [implemented explicit unlimited contract](2026-10-17-unlimited-task-runs.md):
public null, an exact mode/legacy-refusal tuple, guarded schemas, original counts,
pause/resume and capability-gated UI. The historical audit above explains the
gap; it is not the current claim that only finite tasks exist. Discovery factual
collection, policy/signal admission and the rest of this plan remain unfinished.

## End-to-end design

1. The owner chooses project/workspace/role and explicitly saves off, discover-only,
   or discover-and-work policy. The default is off. A reviewed cycle apply remains
   explicit in both active modes. Preserve unlimited owner model budgets; do not
   add a hidden daily dollar/token ceiling. Optional cycle/attempt settings must
   be visible and use existing task/budget contracts.
2. A read-only collector builds current scoped policy/role/source/native/capacity/
   budget facts. Pure gates return eligibility advice only, never permission or a
   scheduling receipt. Unknown/stale data blocks. Future live admission must read
   and validate those authorities again inside the original transaction.
3. The existing maintenance/Worker loop coalesces eligible project signals and
   creates one original owned task occurrence/run through existing repositories.
   A discovery intent links source/policy revision and original budget scopes.
   A unique reservation prevents competing Workers or restarts creating another
   model attempt. No new Agent model loop or automatic ordinary-chat prompt.
4. Original DSH planning produces structured proposals with summary, rationale,
   source signals, exact proposed change, ordered steps and verification. Dedup
   uses owned scope and normalized objective/source, not a title match. No-plan
   records dormancy at the exact source revision; a later relevant revision may
   wake it. Watcher loss/overflow requires a bounded scan, never guessed equality.
5. Discover-only waits for owner selection. Discover-and-work may admit the
   already-authorized proposal through the original task/Goal chain. It executes
   in an owned isolated cycle workspace; no production-root permissions are
   inherited simply because the same files are visible. Tool/model unknowns keep
   their original fences and accounting; repeated observation creates no call.
6. Plans in one cycle share its isolated workspace and scoped memory references.
   Source/task cancellation, role changes, project deletion and user input revoke
   stale admission. Pause/stop cannot be undone by signal arrival or a timer.
7. Reports separate tool receipts, files, verification, failures and unavailable
   evidence. Completed native Goal without canonical delivery/report is not an
   accepted work cycle. In-app history uses existing events/artifacts; optional
   email/IM stays on existing reviewed recipient/outbox permission paths.
8. Apply shows an immutable diff and source/base identities. Explicit owner CAS
   starts an idempotent apply intent; it refuses changed source, path escape,
   link substitution and missing base. Conflicts remain reviewable. Process exit
   preserves unknown apply state; no speculative rerun or reset to ready. Revert
   creates a new reviewed operation and cannot undo external actions/restore old
   permission or memory authority.

## Implementation sequence and acceptance

### A. Readiness contract and factual source adapter

Implement `always-on/discovery-gates.ts` as pure, non-authorizing eligibility.
Test absent policy, ownership/version changes, missing workspace/project, unknown
Host idle, actual busy run, recent input, cooldown, budget holds, capacity,
dormancy/new signal, cycle capacity, held/unknown reservation and malformed/stale
observations. No filesystem/database/model activity inside the evaluator.
Then add a read-only adapter over existing owner/role/run/budget/native facts;
do not accept a browser-supplied idle/budget assertion. Endpoint reads must not
create defaults, signals, leases, policies or work.

### B. Policy, source signal and occurrence admission

Add project-scoped policy revisions and immutable discovery bindings in the
existing Gateway DB. Use original command idempotency for writes and retain
unknown browser receipts. Relevant signals have durable monotonic revisions;
exclude cycle state, outputs and own generated input from recursive triggers.
Admission rechecks policy/role epoch/current original authority and uses existing
task occurrences and budget scopes. Test two-process race, midnight/restart,
archive/delete, lost 202, source revision changes and user pause/stop. No default
enablement or reinterpretation of configured tasks as discovery permission.

Before connecting standing occurrences, audit the existing run-limit consumers:

- `persistent-tasks/service.ts`: stored/public budget, create/update validation,
  resume/run admission, occurrence increment/exhaustion SQL and workspace projection.
- `persistent-tasks/routes.ts`: request schema; `contracts/types.ts` and both
  OpenAPI documents: public nullable/unlimited representation and compatibility.
- `web/workbench/form-state.mjs`: request building, default/edit forms and
  `canResumeTask`; `TasksPanel.tsx`: review, counter and action state; `types.ts`:
  the shared task shape; `task-save.mjs`: durable exact-payload receipt recovery.
- Existing bounded task, dialogue, delivery and browser-form tests: preserve
  configured finite exhaustion, one-off semantics, cancellation, unknown outcomes,
  idempotency and old saved drafts while testing explicit unlimited operation.

`workbench/service.ts` also has mailbox `max_runs`/daily quotas. Those are a
different thread/resource policy, not the persistent task budget. Do not change
them through a broad text replacement or claim unlimited task runs remove them.

### C. DSH planning, native task/Goal execution and reports

Extend the existing `jot_workspace` operation family, not the public MCP count.
Validate bound plan/report operation identities; keep mode, source, occurrence,
model accounting and allowed tools original. No extra LLM summarizer or fallback
planner. Actual locked-SDK tests must prove one planning attempt, original native
execution, canonical report/file handoff, restart/no-repeat and unknown fees.
Scripted-provider cases remain separate from real-provider acceptance.

### D. Isolated workspace and reviewed apply

Implement owned snapshot-copy and Git worktree providers against explicit source
roots and frozen bases. Reject symlink/junction/outside/private-config paths.
Use bounded streaming hashes/copies and preserve actual file/version receipts.
Test partial copy, rename, binary/large files, base drift, deletion conflicts,
Windows paths/locks, competing apply and process death before/after each receipt.
No destructive cleanup of a user checkout; preserve needed recovery artifacts.

### E. Interface, monitoring and rollout

Add project discovery controls/history to the existing workbench: off by default,
clear idle/blocked reason, plan/report preview, pause/stop, cycle diff, explicit
apply/retry/rollback. Keep homepage role-management placement. Verify real built
browser reload/crash/owner switches and responsive input. Source prompts/tool
output cannot alter policy or approve an apply. Add actual provider usage/quality,
process-exit matrix, Windows local build, production canary/rollback and public
disclosure review before enabling it. Keep full 26-capability acceptance open.

## Delivery status

This plan defines the complete work, not a claim that the pipeline exists. The
initial pure gate contract is only prerequisite A; policy/collector, admission,
DSH execution, workspace/apply, UI and deployment acceptance remain required.

The first 30 local gate cases pass, including all four scope identities, changed
policy/role versions, unknown Host idle, stale/future facts, cooldown boundaries,
explicit nullable facts, new dormant signal, unknown reservations and malformed
records. A positive result remains frozen advice only. There is no factual
collector, active timer, persistence policy or dispatch hook in this milestone.

Full local verification: Gateway 1347 total, 1340 passed, six existing skips plus
the separately opt-in output-load skip, zero failures (163.96 seconds), and
Windows Gateway build. Root32/32 and Windows root build pass. Public regressions
6/6 and the 757-file working-tree disclosure scan pass; BRAIN links pass for
three pages. An initial TypeScript callback narrowing error was corrected by
retaining the already-validated scope locals, without weakening runtime checks.
No new actual SDK/provider or deployment claim is made: the new pure module has
no runtime dispatch hookup to exercise. Earlier SDK results remain separate
historical evidence. Next is the explicit unlimited task-run contract followed
by factual observation/policy/occurrence wiring, with all later phases retained.

### Native Host observation prerequisite

The optional internal protocol now observes current Host quiescence through
`POST /v1/sessions/:id/idle-observation` with exactly `{ "protocol": 1 }`.
Bearer authentication remains mandatory. The separate readiness endpoint takes
an empty object. Enable `nativeIdleObservation: true` only in the trusted Host
adapter configuration; the generated standard profile keeps it disabled.
This is not a public conversation route or model tool.

Live observation reads the already attached Agent, native inbox and Goal service.
Running, pending input or an armed Goal means busy. Two reduced snapshots and
the original registry identity must agree. Cold observation reads the official
Session projections twice without resolving an Agent; pending input or an active
persisted Goal means busy. A missing Session means unknown, never idle. Missing
services, invalid shape, changed state or unsupported preset cannot produce idle.
Only reduced facts leave the Host: protocol, Session ID, basis, idle state,
reason, observation timestamp and `execution_authorized: false`. Goal objectives,
inbox content and raw exceptions are excluded. The Gateway client rejects extra
fields, inconsistent basis/reasons, changed identity and any claimed authority.

The isolated pinned official Host test exercises the real Gateway client and
authenticated HTTP adapter before and after restart. A paused Goal is unchanged;
the restarted Host creates zero Agents and makes zero model calls while reading
the persisted Session. An absent Session remains unknown. This proves the tested
Host observation behavior, not a universal disk no-write guarantee, provider
completion, fleet-wide idleness or execution admission.

This prerequisite does not install the project source collector. Next, collect
owned project/workspace/role versions, all relevant Session bindings, recent
user input, original run occupancy and existing budget/capacity facts. Reconcile
Host timestamps with bounded freshness; do not promote an empty binding set or
an unavailable Host into idle. Revalidate the owner policy and original execution
authorities transactionally before an occurrence is admitted. Policy storage,
signals/reservations, DSH planning/work cycles, reviewed apply, UI, real-provider
and deployment acceptance remain required in the original full scope.

Local verification for this prerequisite: Adapter suite 509 total, 485 passed,
24 SDK-dependent skips, zero failures; Gateway suite 1359 total, 1352 passed,
seven existing/opt-in skips, zero failures (146.36 seconds). After two additional
test-only cases, the focused Adapter/client set passes 25/25. The separately
configured pinned SDK restart test passes 1/1 through the real authenticated
HTTP adapter and Gateway client. Root runtime passes 32/32; Windows Gateway and
root builds pass. The Adapter package dry-run includes the new module. Public
regressions pass 6/6 and the 764-file working-tree preflight has no findings.
No production flag, model invocation, scheduler or user task was enabled.
