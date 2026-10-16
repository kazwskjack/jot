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

### Project activity source adapter

`ProjectActivityObserver` now reads the original product database for one exact
owner/project/workspace/role scope. It uses short deferred read transactions,
then releases them before any Host request. It reads the owned project version,
role version/epoch/status, all scoped conversations (including archived ones),
their native Session bindings, original runs, pending Goal controls, native child
execution Session identities, and stored user-message metadata. Original user
identity formats remain supported. No defaults, policies, reservations, leases,
signals, directories, conversations, Agent instances or model calls are created.

The Workbench's new `projectWorkspaceReady` checks an existing scoped directory
without calling the directory-creating `projectRoot` method. Existing canonical
root, ownership, workspace membership and symlink/junction checks remain in force.
A missing directory is unavailable. A missing binding (including an unbound
scoped conversation) stays unknown; an empty set is never accepted as native idle.
Queued/nonterminal runs and unresolved queued/dispatching Goal controls mean
busy. Every collected parent/child Session must independently provide valid idle
evidence from the configured Host, within the observation freshness window.

After Host IO, the collector reads the database and workspace again and compares
the reduced source fingerprint. Input identity metadata is included, so replacing
an input while preserving its count and timestamp still invalidates the sample.
The oldest Host observation must remain fresh through the final recheck. SQL
write transactions are never held over network requests. Private message bodies,
role instructions, titles, child snapshots, native Session lists and machine paths
are excluded from the returned facts; the source hash is not an authorization.

`last_user_input_at` conservatively includes stored user-role inputs generated by
internal task paths as well as human input. `last_terminal_at` is a cooldown hint
from terminal run records, not proof of successful completion, canonical delivery
or settled provider cost. The observer reports activity only. It does not claim
budget allowance, background capacity, fleet-wide native presence, saved policy,
signal/dormancy state or an occurrence reservation. Those still need integration
with the existing live authorities, followed by atomic original-task admission.
No public route, periodic loop or production activation is installed here.

Verification: final Gateway suite 1379 total, 1372 passed, seven existing/opt-in
skips, zero failures (149.49 seconds), including 19 project-source tests. The
source integration test uses real SQLite/Workbench records, the real Gateway
client and a loopback authenticated Adapter handler; Host Agent facts in that
test are synthetic, not a new actual SDK/provider acceptance claim. It verifies
no SQL transaction remains open during HTTP observation. Independent-connection
input writes remain possible and invalidate the old source. Junction replacement,
missing/foreign scope, archived/child Sessions, cancellation, expired observations,
same-count input replacement and supported owner identity formats are covered.
Root tests pass 32/32; Windows root and Gateway builds pass. Public regressions
pass 6/6 and the 766-file working-tree preflight has no findings. An initial
fixture cleanup failure was fixed by closing its second SQLite connection before
removing the owned temporary directory; production ACLs were not changed.

### Durable policy and source-signal foundation

The original Gateway database now owns one discovery policy per exact
owner/project/workspace/role scope. Lookup returns a null policy and performs no
default creation. Saving requires exact current policy and role versions, explicit
mode/timing values and nullable cycle capacity. A new saved configuration is off;
configuration edits preserve paused/stopped state. Enable, pause and stop are
explicit owner commands with current-version checks. Role revision/epoch or
status changes revoke effective active state. Reconfiguration after revocation
leaves the policy paused until an explicit enable captures current role authority.
No policy record grants a model call or bypasses ordinary tool approval.

Immutable per-policy revision records retain the original command key, canonical
request hash and exact receipt. Head, revision and command receipt commit in one
transaction; duplicate requests recover that receipt, and changed bodies conflict.
Head deletion/replacement, history mutation and history replacement are rejected.
Replaying an old enable receipt after a later stop does not re-enable the head.
Clients must refresh current status after recovering historical command receipts.

Three owner API operations are registered in the existing authenticated Gateway:

- `GET /v1/agents/:agentId/discovery-policy` reads current configuration/effective
  state without creating policy, source signals or directories.
- `PATCH /v1/agents/:agentId/discovery-policy` saves exact configuration, with
  policy and role version checks and an original idempotency key.
- `POST /v1/agents/:agentId/discovery-policy/control` accepts explicit enable,
  pause or stop. Enable additionally requires current role version/epoch.

Scope is derived from the owned role rather than client-supplied owner/project
fields. JSON/YAML OpenAPI, operation manifest and TypeScript contracts agree.
The existing origin/CSRF/actor checks and atomic response-validation/receipt
protocol wrap these writes. Only matching `discovery-policy-atomic-v1` pending
reservations can recover; legacy unconfirmed records remain blocked. Immutable
business receipts retain deduplication even if the generic HTTP cache is removed.
These API operations configure future discovery. The fixed-task preparation
milestone below adds one unscheduled original task on explicit enable; it does
not install occurrence admission, a running scheduler or periodic model calls.

Internal signal ingestion records only kind, opaque source identity, monotonic
source version, source digest and policy revision. Duplicate source/version/hash
returns its original signal revision; changed hashes conflict and unseen older
versions are rejected. Own cycle/generated origins are ignored. Off/stopped or
revoked policies cannot ingest new signals; paused policies may retain relevant
external changes but are never resumed by ingestion. Journal revisions survive
restart and cannot be changed, replaced or deleted. Signal ingestion is not a
public API or model tool; trusted source adapters must establish provenance and
exclude own outputs before invoking it. It is not connected to watchers yet.

Remaining B work includes durable dormancy/no-plan proof, coalescing/reservations,
budget/capacity and unknown-outcome sources, fresh native/source admission fences,
original task/occurrence binding and restart/rollout acceptance. Source journals
currently retain append-only evidence; production growth, compaction and evidence
retention need explicit acceptance before enabling watchers. All C–E work and
the original full 26-capability scope remain required.

A local synthetic SQLite measurement appended 1000 external signal versions for
one source/policy. Allocated database pages grew by 454656 bytes (444 KiB), about
455 allocated bytes per signal in that sample; the complete fixture database was
1404928 bytes. Ingestion took 8.43 seconds and created zero task runs. This is a
single local Windows sample, not a production daily growth rate or throughput
guarantee. Page allocation, indexes, source diversity and future coalescing affect
growth. No watcher is enabled, so this measurement creates no production events.
Retention/archival and real cohort growth remain open acceptance work; do not
delete immutable evidence or weaken its triggers as a shortcut to compaction.

Verification for this foundation: final Gateway suite 1396 total, 1389 passed,
seven existing/opt-in skips, zero failures (149.69 seconds). The 17 focused
policy/API/contract cases cover restart through a second connection, competing
independent processes, failed receipt rollback, immutable history/head protection,
owner/CSRF/origin checks, lost atomic receipt recovery, removed HTTP-cache recovery,
explicit null and role revocation. Root tests pass 32/32; Windows Gateway/root
builds pass; public regressions pass 6/6 and final 772-file preflight has no findings.
BRAIN links are clean. The first full suite exposed declaration-spacing drift
against an existing contract rule; it was corrected without weakening the check.
One earlier public preflight could not finish inspecting the tree; the failure
was retained, and both direct and final complete scans pass. No actual-provider,
production deployment, watcher, occurrence or new SDK execution claim is made.

### Original budget and background-capacity observations

`TaskBudgetService.observeAdmission` reads an existing owned persistent task,
its version/generation, the current registered budget-policy revision, existing
limits/balances/holds and durable-root usage. It neither creates a scope nor
reserves, refunds, reconciles or dispatches any call. Explicit unlimited money
remains null; token/call limits and every original accounting fence are unchanged.
Missing budget configuration is unknown, exhausted limits are blocked, and
unknown/in-flight root usage remains unknown for a new occurrence. Stale process
policy rejects the read. Task and budget revisions are observation facts, not an
execution lease or permission to borrow another task's allowance.

The task budget projection previously counted unknown/unmetered calls through
task occurrence and mailbox run lists. A member with a valid binding to the same
durable task-total scope could therefore be absent from the displayed count,
although the ledger's dispatch/admission unknown-usage fence already covered it.
The projection now asks the original ledger for usage bound to the exact owned
durable root. That includes members, continuations and scoped auxiliaries;
overlapping owner/project/agent daily budgets alone do not fence another task.
Their actual used amounts and holds still reduce shared remaining allowance.
No competing usage counter or settlement path is added. Public response fields
remain unchanged. Budget GET and these observations use short deferred read
snapshots rather than acquiring a SQLite writer reservation merely to inspect.

`HarnessCoordinator.observeBackgroundCapacity` reads its own trusted configured
background limit and the same active-lease SQL used by `claimNext`. It reports
global and owner occupancy and the remaining logical background slots, without
claiming a run or writing a lease. The common SQL retains the existing task,
mailbox and memory-extraction categories and lease expiry semantics. Foreground
priority and the separate physical Worker pool remain unchanged. Disabled
background execution reports zero available slots. These counts do not prove
native Host quiescence, idle hardware, a live Worker fleet or permission to run;
Host readiness/freshness and original transactional claim/dispatch remain required.

These components are not yet a discovery occurrence admission. Before combining
them with project facts and pure gates, establish an immutable original task
binding for the policy, carry source/signal/policy/role revisions, inspect remaining
reconciliation states, and atomically revalidate the real limits/reservation.
Never choose a fresh task/root to evade a prior unknown call or cumulative quota.
No discovery timer, watcher, task, Agent, model call or production enablement is
created by this milestone; the remaining full lifecycle is unchanged.

Verification: Gateway 1403 total, 1396 passed, seven existing/opt-in skips,
zero failures (159.29 seconds). Seven new source cases cover no-write/no-scope
observation, explicit unlimited money, missing/exhausted budget, a synthetic
member sharing the original ledger root, unrelated daily siblings, active and
expired background leases, foreground claim while background slots are full,
disabled background execution, in-flight calls and stale process policy. The
initial regression reproduced a displayed unknown count of zero for the shared
member while the original root had one unknown attempt. Existing budget-public
and Coordinator focused tests also pass (26-case earlier focused run); root32/32
and Windows root/Gateway builds pass. Public regressions6/6, 773-file preflight0,
and BRAIN link checks pass. No new provider/SDK run or production rollout is claimed.

### Fixed original task and budget identity

The trusted Gateway policy-command callback now prepares exactly one original
persistent task when the owner explicitly enables a policy. Default lookup and
off-mode save still create none. Policy head/revision, task creation, immutable
scope binding and original API receipt commit atomically; a failed binding insert
rolls all of them back. Replaying an older command does not rerun the callback or
rearm the current task. Independent processes replaying the same enable converge
on one policy receipt and one original task.

The binding permanently fixes policy/task/owner/project/workspace/role identities.
Its original task uses the explicit unlimited tuple and a dedicated read-only
`project_discovery` trigger with no due time. Only response DTOs accept that
trigger: ordinary create/update/preview inputs retain their configured trigger
schema. No discovery occurrence or budget scope/call is allocated at preparation.
Future task-total allowance remains derived from this one task ID, rather than
choosing a new task after a stop, exhausted quota or unknown provider outcome.

Pause/stop synchronizes through the original Task transition/cancellation path;
an explicit later enable resumes the same task without resetting its run counter.
Role drift still revokes policy activity; saving current role settings leaves the
task paused until fresh explicit enable. Generic managed-task run/edit/lifecycle
commands are refused; the task card shows discovery-policy management rather than
ordinary run/edit buttons. Existing task budget controls and accounting are kept.
Configuration-only task-service integrations may expose a narrower role facade;
managed preparation still requires real matching role version/epoch and fails
closed if those are missing. The SQL binding verifies the immutable owned policy
and task identities; current role validation occurs in that same command transaction.

Database guards prevent binding mutation/replacement/deletion, task identity or
content/trigger changes, rescheduling, changing the unlimited tuple and decrementing
the accumulated run count. The ordinary timer explicitly skips this trigger. A
separate SQL occurrence-insert guard currently refuses every managed occurrence,
including legacy callers: this milestone deliberately has no admission escape
flag or caller-supplied authorization boolean. Next, replace that closed guard
transactionally only with the verified original occurrence/reservation protocol,
carrying source/signal/policy/role/task revisions and all current authority checks.
Until that implementation and its acceptance pass, prepared tasks cannot execute.

Schema installation is transactional and ordered after task-limit migration;
all referenced discovery tables exist even in standalone task-service startup.
The old-layout fixture now removes feature-dependent triggers only while building
its isolated pre-feature layout, then asserts migration restores them. Production
guards remain enabled. This is preparation and storage compatibility, not full
mixed-fleet rollout/rollback or real-provider acceptance.

Verification: final Gateway 1412 total, 1405 passed, seven existing/opt-in skips,
zero failures (155.59 seconds). The nine new binding cases include two independent
enable processes, stable identity/counter across lifecycle commands, role reconfig,
atomic failure rollback, no ordinary-timer admission, legacy SQL guard refusal and
complete standalone referenced schemas. Root32/32, workbench154/154 and Windows
root/Gateway builds pass. Final real Edge testing runs the built UI through the
original BFF and real isolated Gateway/SQLite: one task, pause/resume/stop, managed
controls, zero occurrences, zero model runs and zero page errors. Public6/6,
777-file preflight0 and BRAIN links pass. The first full run caught an old-layout
fixture/schema compatibility failure; the final run retains all original migration
and protection assertions. No actual SDK/provider execution, deployment or active
discovery acceptance is claimed. Run the browser check with
`node scripts/verify-discovery-task-ui.mjs` after a local root build.

## Trusted database source ingestion milestone

`DiscoverySourceCollector` now supplies actual source metadata to the durable
signal journal. The existing `maintainWorkbench` lifecycle calls it only after
execution readiness; there is no new timer, Agent, model call or default policy.
Internal batches are bounded to 50 source rows per policy and ten policies per
maintenance pass. These are drain batches, not cycle/token/budget ceilings. A
round-robin policy cursor wraps; input/file streams interleave; journal identity
is the deduplication authority. No timestamp or rowid watermark can skip a late
source. Restart repeats evidence checks without duplicating signals.

Input sources are complete user-message identity metadata on original `chat`
bindings belonging to the configured role conversation, owner, project and
workspace. Task/mailbox/native-helper inputs and private inputs in other role
conversations are not promoted. Message bodies, attachments, OCR and images are
not read. The current product has no message-edit revision protocol: an input
identity is version one, not a claim to observe future content edits.

File sources are the original owned immutable `wb_file_versions` metadata,
including every version in order for a logical path. No blob is read, no project
directory is created, and no physical filesystem watcher is installed. Unattributed
owned versions are base-file metadata, not a claim of human authorship. When a
producer is recorded, the collector validates its original owned run/conversation
and nonempty budget-scope binding. Any matching discovery task cumulative scope
in this project excludes the output, including derived/native/helper runs and
other discovery roles. Invalid or absent recorded-producer lineage is unconfirmed:
it does not become an external signal and later versions of that path wait too.
This classification is based on trusted records, never a model-origin boolean.

Source reads, current policy/role checks and journal writes share one bounded
metadata transaction, with no network, Host call or body/blob hashing under its
writer lock. Digests/source IDs contain no raw message or path. This is metadata
evidence, not file-byte integrity verification: the original execution/file APIs
must still validate content and permissions when needed. A failed journal insert
rolls back the complete batch. Off/stopped and revoked roles do not collect;
paused policies can accumulate evidence but cannot resume or execute. Missing
provenance schemas remain unavailable rather than positive readiness.

The managed-occurrence SQL guard remains closed. Source ingestion alone is not
coalescing, dormancy, a reservation, idle/budget/capacity authorization, DSH planning,
execution or accepted reporting. Before opening admission, combine these facts
with the original policy/role/task/native/budget/capacity authorities and immutable
reservation inside the original occurrence protocol. Full isolation, reviewed
apply, policy UI, provider, rollout and production acceptance remain required.

Validation: complete local Gateway 1424 cases, 1417 passed, seven existing/opt-in
skips, zero failures (158.66 seconds). Eleven source-collector tests plus the
existing scheduler cases and new lifecycle test pass as a focused 16-case suite.
They use real isolated SQLite, Workbench file versions, original chat bindings,
budget scopes and maintenance. Synthetic derived-run lineage is explicitly not
an executed SDK/provider cycle. Cases cover no default/off/stopped writes,
repeated ingestion, all file versions across drain batches, role/owner isolation,
revocation, paused accumulation, derived-output exclusion, unresolved producer
and later-version holds, complete rollback/retry, and zero new occurrences/runs/
model attempts during maintenance. Root32 and local Windows Gateway/root builds
pass. Public6 and 779-file preflight have zero findings; BRAIN CLI links pass.
No production change, new automation or actual provider run is claimed.

## Original planning occurrence admission milestone

`DiscoveryAdmissionController.admit` now collects the exact owner/project/workspace/
role sources, obtains actual project/native activity through the original observer,
and enters the original `PersistentTaskService` occurrence transaction. There is
no public/model endpoint, extra Agent, model loop, alternate queue or automatic
Worker discovery dispatcher. The controller accepts trusted service objects, not
browser/model snapshots or an `execution_authorized` boolean.

Inside admission it rechecks the current policy and source journal, an exact fresh
idle receipt issued by that observer, original scoped SQL/workspace identity,
original task budget/accounting and Coordinator background slots. The observer's
Host IO is still forbidden inside a caller transaction. Only synchronous source
revalidation is permitted there; it checks full scoped identity metadata and the
existing workspace path, without body/blob reads or directory creation. Scale
acceptance for large project metadata histories is still required.

The signal head identifies an immutable ordered journal prefix. One original
task generation/source-head pair has one immutable admission identity. Signals
arriving during observation invalidate that batch; repeats do not create another
occurrence. A prior unaccepted/unknown occurrence holds even after native runtime
termination. This is once-per-signal coalescing, not proof of an accepted no-plan
report or completed dormancy protocol. Cycle limits use the original accumulated
run count; explicit unlimited remains unlimited.

`wb_discovery_admissions` is evidence linking an exact original task/occurrence,
policy/role versions, task generation, source/activity digests and original budget
revision. It owns no replacement task status. Its deferred foreign key requires
the exact occurrence to commit in the same original transaction. Reservation,
conversation, queued input/run, original occurrence, original budget allocation
and count therefore roll back together on failure. Budget allocation may create
the normal never-dispatched admission hold; that is not a model request and must
not be reported as zero accounting reservations.

The previous unconditional SQL occurrence guard is now transactionally upgraded
to require the exact immutable reservation plus current policy/task/source
identities and deterministic trigger key. Generic/legacy insertion remains refused.
The existing original task limit/active occurrence, binding, role/permission,
budget/lease and execution protections still apply. The receipt does not by itself
authorize execution, tools or model dispatch.

This increment admits **discover-only planning**. The generic authenticated
workspace transport enforces a read-operation allowlist before dispatch, refusing
file writes, memory writes, messages, delegation and other mutation. Original
model/tool identity checks revoke planning after policy/role/version changes or
stop. Discover-and-work refuses admission until isolated work-cycle authority is
implemented. Planning/report task metadata contracts still need integration; do
not enable the automatic dispatcher just because a queue fixture passes.

Remaining sequence: structured source-backed plan/report operations in the original
workspace family; accepted no-plan/dormancy and exact report/occurrence binding;
isolated cycle provider, shared scoped memory and explicit reviewed apply; full
policy/work-cycle UI; original Worker lifecycle dispatch configuration and actual
DSH/provider restart/pause/stop/unknown-outcome acceptance; then production rollout
and the complete capability inventory. No production setting is changed here.

Validation: final local Gateway1439 cases/1432 passed/seven existing or opt-in
skips/zero failures (157.07 seconds), including fourteen admission cases and the
new issued-receipt revalidation regression. Earlier focused44 original task,
migration and admission cases passed; the initial full1438 run preceded the final
scope-freezing correction and is not substituted for final verification. Tests
exercise real SQLite/Workbench/original queue/budget/Coordinator with controlled
native-idle fixture responses. Two independent Node fixture processes reserve one
original queue entry; these are test processes, not AI subagents. Authenticated
Gateway transport allows a scoped file read and refuses a write before mutation.
Native/model/provider execution is not claimed. Rollback, policy/source drift,
unknown idle, budget/capacity refusal, immutable history and caller-scope mutation
are covered. Root32 and local Windows Gateway/root builds pass. Built Edge UI
through the original BFF and isolated Gateway retains one managed task and
pause/resume/stop with zero unintended occurrences/model runs and zero page errors.
Public6 and 783-file preflight have zero findings; BRAIN CLI links pass. Automatic
dispatch, planning metadata/report operations and full lifecycle acceptance remain
open; the planning allowlist must be extended through reviewed original task
operations when that protocol is implemented.

## Structured planning and report evidence milestone

The existing original `jot_workspace` tool now exposes four discovery operations;
there is no additional public MCP, planner, model or task status store:

- `discovery.context` pages this admission's new signal range using
  `after_revision`. It also pages proposal summaries with `after_plan_id` and
  reads one owned full proposal with `plan_id`.
- `discovery.source` reads one admitted revision with optional `offset`. It
  revalidates original owned file-version metadata and actual pinned bytes, or
  the bound role-chat input identity before reading its text. Sources are
  untrusted data. Images/non-text blocks are omitted, never automatically loaded.
  Text chunks preserve surrogate pairs and return an exact `next_offset`.
- `discovery.plan` records summary, rationale, logical target changes, ordered
  steps, verification and genuine occurrence-owned source receipts. Targets are
  proposals, not filesystem writes. Normalized work and source hashes deduplicate
  repeated proposals even with another call ID, title or repeated source receipt;
  exact original call retries retain their existing idempotency semantics.
- `discovery.report` records outcome, summary, limitations, proposal IDs, source
  evidence and server-derived coverage. `plan_ids:[]` derives the entire current
  manifest; a nonempty list must match it exactly. The explicit-ID input bound
  therefore cannot impose a total plan count ceiling. Reports cannot hide plans
  or call a record an accepted business result.

The generic planning allowlist now permits original `tasks.upsert/evidence/observe/
assess` and read operations for this exact original task. Existing CAS, permission,
dependency, evidence, lease and accounting checks still apply. Project file writes,
memory writes, messages and delegation remain denied. Plan/report mutations use
the original tool-call receipt/retry path; self-authored plans and reports are not
attested as independent execution/source evidence.

Actual source retrieval is attested before the original transaction writes an
immutable source-range receipt linked to the original execution receipt. A source
counts as fully read only when its chunks form a contiguous chain from zero to
the final chunk. A no-plan report requires every current-batch source; a tail-only
read, ordinary unpinned read or model statement is insufficient. Other reports
with incomplete coverage require explicit limitations. Report steps must already
be complete with original verified evidence. Blocked reports currently describe
completed inspection with limitations; failure diagnostics without completed
inspection still require original task wait/recovery integration.

Plans and report revisions are immutable evidence bound to the original admission,
task generation/source and role/policy versions. The current report also binds the
current lead, exact task-step revisions, user-input identity metadata and complete
proposal set. New proposals or changed steps/input make it stale. Newly journaled
sources revoke original discovery execution through its existing guard, including
model/tool calls. A valid report is required before native completion proposal
and is included in the original frozen completion candidate and certificate hash.
Existing owner business review and original native Goal completion/publication
remain authoritative. There is no separate accept/apply operation in the model
tool and no automatic promotion of `accepted:false` records.

Storage grows with proposal/report JSON, source-range metadata and the existing
tool response/receipt cache. Duplicate work does not create another proposal;
source text chunks still use the original durable response cache for exact retry.
No production growth/retention or large-history performance claim is made. The
metadata/context batch sizes and text chunks are drain/paging bounds, not new
task/token/dollar limits. Production retention and scale acceptance remain open.

Next required integration: a dedicated actual DSH discovery planning/approval
case, accepted no-plan dormancy derived from original business/native finalization,
failure/wait/recovery handling, isolated cycle workspace/shared memory/reviewed
apply, full UI, original Worker lifecycle dispatch, real-provider quality/cost,
pause/stop/restart/unknown-outcome and production rollout/full inventory acceptance.
No production setting or automatic discovery dispatcher is changed here.

Validation: final complete Gateway1453 cases/1446 passed/seven existing or opt-in
skips/zero failures (158.12 seconds). Fourteen planning tests cover typed source
readback, omitted images, contiguous Unicode-safe long-text reads, source coverage,
proposal dedup across call IDs/titles, full derived manifests including 33 proposals,
immutability/idempotent retries, stale reports, source drift and the actual original
Goal completion candidate containing the report. Controlled native checkpoint and
accounting facts are fixtures, not a new discovery SDK/provider acceptance.
The full Session adapter suite is511 cases/487 passed/24 existing opt-in skips/
zero failures. Three selected existing regressions use the pinned official DSH
SDK, real Gateway/Worker and native Goal with synthetic local Messages transport:
saved role, reviewed file task and unlimited reviewed file task all pass. They
make seven synthetic model requests, not real-provider calls, and do not prove a
dedicated discovery run. Root32 and Windows Gateway/root builds pass. Public786-file
preflight has zero findings. Remaining acceptance and all full-scope requirements
above remain open; automatic discovery dispatch is not installed.

## Original SDK discovery and accepted dormancy

The dedicated discovery fixture now runs the pinned official DSH launcher, real
Gateway/Worker, original authenticated workspace tools, source receipts, budget
settlement, owner business review and native Goal completion/publication. Its
Messages HTTP model is scripted locally: this verifies integration, not provider
quality or production readiness. The proposal case reads one pinned source,
records one plan/report and publishes one owner-accepted original result without
modifying the source workspace.

Dormancy is a read-only derivation of the original immutable admission, report,
frozen completion candidate, owner certificate/review, native completion proof
and committed assistant message. Hashes and exact identities must agree. A
no-plan report or owner review alone cannot establish dormancy. Legacy completed
status projections without canonical finalization hold the next admission.
Missing/foreign tasks never count as accepted predecessors. Invalid evidence
returns unknown and blocks; observation creates no status, authority, lease or
model attempt.

The no-plan fixture stops its original Worker at the review boundary, accepts
through the owner API and restarts the Worker against the same database. Only
original native completion/publication establishes accepted dormancy. An
unchanged source returns DORMANT_NO_SIGNAL without another model call. A new
owned source revision can queue the second occurrence of the same task and
cumulative budget, subject to all current policy, role, idle and capacity checks.
That second occurrence is queued only in this fixture, not executed. These are
controlled lifecycle stops, not retries caused by an observation timeout.

This does not install the automatic discovery dispatcher or enable production.
Failure/wait/recovery, isolated work/shared memory/reviewed apply, full policy and
work-cycle UI, real-provider quality/cost, complete lifecycle and rollout/full
inventory acceptance remain required.

Verification of this milestone: all ten Gateway/Worker SDK cases pass with the
pinned official runtime and scripted local Messages transport (86.79 seconds).
The two discovery cases consume six and five synthetic requests respectively;
the accepted no-plan case checks read-only observation, foreign-owner denial,
review-before-native-completion, one committed reply, Worker restart, unchanged
source dormancy and same-task new-source admission. The entire fixture group
makes 29 scripted model requests. These are not real-provider calls.

An earlier parallel heavy regression produced one OBSERVATION_STALE refusal for
the second admission: it created no new run and did not relax freshness. All ten
cases then passed sequentially with the existing five-second evidence window.
Restricted-shell root/Gateway checks also encountered loopback EACCES and
directory-link restrictions; the root32 pass in the authorized Windows user
context. Environment refusals remain recorded separately from product defects.

Final complete Gateway regression:1456 cases,1449 passed,seven existing/opt-in
skips,zero failures (187.96 seconds), including all three dormancy/predecessor
tests. Root32, ten actual-SDK/scripted-model cases, public disclosure6 and
788-file preflight pass. Local Windows root and Gateway builds pass. No
production switch, provider call or new
automation is enabled by this milestone.

## Repairable source failures and original wait recovery

An additional actual-SDK canary deliberately corrupts only the pinned blob in its
isolated synthetic workspace. It exposed that a file integrity failure became
INTERNAL_ERROR and then workbench_run_forbidden at the bridge, hiding a repairable
source failure behind an authority rejection. Pinned source retrieval now maps
integrity failure and expected absent bytes to fixed discovery-source errors.
The bridge exposes only exact allowlisted409 codes on the tool endpoint, and
missing/stale report conflicts on completion proposal. It never copies Gateway
detail text or paths. Unknown errors, owner/permission denials, source drift and
revoked authority remain generic fail-closed errors.

The failed read does not insert a successful execution/source-range receipt or
claim coverage. The original DSH Goal asks for user input, checkpoints and stops.
The canary stops that Worker, restores the exact original bytes without changing
the source version, answers the original interaction and retries the response
with the same command key. Exactly one continuation inherits the original task,
occurrence, native Session/Goal and cumulative budget. A restarted Worker reads
the pinned source successfully before creating the evidenced inspection/report;
normal owner business review and native completion still precede publication.
An unchanged accepted no-plan source sleeps; a later owned version can queue the
same task. The script uses seven synthetic model requests and one final reply.

This verifies one controlled source-integrity failure and original wait/reply
recovery. It does not establish arbitrary crash/IO recovery, a separate verified
failure-report contract, real-provider quality or production behavior. Failed
inspections must not be relabeled completed merely to obtain a report. Pause,
stop, revoked policies and unknown accounting retain original authority.

The public budget-policy fixture now locates repository-local temporary storage
from import.meta.url, with containment checks before creation and deletion. It
does not require a particular Windows drive or caller working directory. All
files in the current Windows implementation remain under the authorized workspace;
this targeted portability repair is not full Linux/Git-provider acceptance.

## Snapshot contention and role policy interface

Repeated actual-SDK regression exposed a snapshot500 independently of discovery
report semantics. A deterministic two-connection test confirmed the initialized
snapshot read tried to write while another connection owned a WAL write lock.
The conversation cursor constructor always inserted its existing key, and default
project resolution always requested a writer transaction/backfill UPDATE. Reads
now reuse an existing valid key and initialized project without writes; genuinely
missing state still initializes under the original writer transaction with a
locked recheck. An owned legacy NULL project still migrates, and foreign reads do
not create a default project. No snapshot serialization, busy timeout or blind
read retry is substituted. Read-only, concurrent-writer, first-initializer race,
legacy migration, stable signatures and corrupt-key rejection are tested.

Role cards now open the original owner-bound discovery policy form. The form
uses original GET/PATCH/control routes, role versions/epochs and command receipts;
it defaults off/discover-only, saves separately from enable and offers pause,
resume and stop. An uncertain response locks competing controls and retries the
exact original method/body/key; CAS drift reloads policy and role instead of
resending. Scope changes remount the form and old owner responses cannot update
the new scope. The managed task stays outside generic edit/run-now controls.

The built-browser scenario now clicks the actual form instead of configuring it
with page.request: save off, lose the committed save response, retry, enable,
pause, resume, stop, refresh and read back. One fixed task/five policy revisions
remain; zero occurrences/model calls are expected because automatic discovery
dispatch is still uninstalled. This is configuration UI acceptance, not execution
or provider acceptance. Owner-readable cycle/report projection, isolated cycle
providers/execution, frozen diff review/apply and remaining full UI stay open.

Validation for the repair/UI milestone: all eleven official-SDK/Gateway/Worker
cases pass with scripted local Messages transport (91.36 seconds,36 scripted
requests). The new source-integrity case uses seven calls and confirms the same
native Goal ID with a newer revision after original input continuation. Fifty
bridge tests and the complete adapter suite512 cases/488 passed/24 opt-in skips/
zero failures pass; planning15, snapshot/project/cursor targeted19, root32,
workbench UI163 and the Windows root build pass. The primary agent reran the
actual form browser scenario against that final build with zero page errors,
zero occurrences/model runs and same-command response-loss recovery.

Freshness refusal remains an expected non-admitting hold. The SDK fixture may
re-observe at most three times only for OBSERVATION_STALE, checking unchanged
run/admission/task usage/provider-attempt/model-request counts after each refusal.
It neither accepts old evidence nor relaxes the original five-second window,
restarts a process or retries an unknown dispatched action. Other refusals fail
the scenario. Earlier snapshot500 and rejected observations remain recorded as
diagnostics rather than passing evidence.

Next work-cycle implementation must not substitute the current logical text file
store for a full provider: it currently accepts UTF-8 files up to1MiB, lists at
most200 records and rejects dot paths. A complete snapshot/Git provider needs
explicit reviewed path scope, paged manifests, binary/large-file handling,
deletions/renames, symlink/junction and private-configuration exclusion, frozen
base/result identities and restart reconciliation. Existing task acceptance
certifies frozen criteria/outputs; it is not permission to apply to the live
project. Apply needs its own exact frozen-diff owner confirmation and per-write
receipts. Keep DSH/original runs, leases and cumulative budgets authoritative;
do not open discover_and_work by allowing planning files.write.

Final complete Gateway run:1463 cases,1456 passed,seven existing/opt-in skips,
zero failures (184.74 seconds). Windows Gateway build also passes after that
run. Public disclosure6,793-file preflight and Brain link checks pass. Reopening
the earlier failed snapshot fixture through a read-only database now succeeds
without changing total_changes. Independent static review found no blocking
owner/permission/idempotency/disclosure defect; this does not replace runtime
checks or close provider, production, isolated-work/apply and full26 acceptance.

## Next isolated-work artifacts and original history integration

The next increment implements real artifacts without opening execution/apply:

- [x] `workspace-provider.ts` / `snapshot-provider.ts`: explicit trusted roots
  and selected relative scope; streamed binary/large-file inventory and copying,
  empty directories, immutable base manifest/hash and creation receipt. Recheck
  drift, owner guard/cancellation, containment, links, case collisions and private
  configuration exclusions. Failed copies retain diagnostic remnants without a
  ready receipt and never recursively remove a user checkout. Result inspection
  is a separate factual read of the isolated workspace, not a model manifest.
- [x] `workspace-diff.ts`: canonical, validated base/result manifest differences,
  exact hashes, add/delete/content/mode/type changes and unambiguous rename
  evidence. Output is non-authorizing and never applies files. Ambiguous matching
  hashes remain additions/deletions; do not guess a rename.
- [x] `discovery-history.ts` / routes: owner-scoped, paged read projection of
  original admissions/current occurrences/runs/reports/proposals/finalizations.
  No new status table, default creation, native Host call or repair on read.
  Canonical acceptance differs from terminal runtime status; corrupt proof holds.
- [x] Existing role policy UI: list original cycles, preview reports, coverage,
  limitations and proposals with scope-safe pagination. Preserve actual policy
  form browser tests, and add original BFF/API history browser acceptance.

These artifacts still require frozen owned cycle identity/root-budget binding,
snapshot/Git provider recovery, original DSH isolated execution and scoped memory,
verified result/report integration, exact owner diff review and idempotent apply
intents/per-write receipts/reconciliation. Neither a snapshot, manifest diff nor
history API is execution permission or reviewed apply. Automatic dispatch and
discover_and_work remain gated until their complete original authority and
lifecycle acceptance is demonstrated. Full26 scope remains unchanged.

### Snapshot/diff and owner-history evidence

Snapshot creation uses64KiB streaming, regular-file descriptor and path/inode
rechecks, frozen base manifests and target byte verification. The selected tree
includes binary files and empty directories. Known private path components,
symlink/junctions, scope/root overlap, case collisions, cancellation, drift and
limits refuse a ready receipt. Partial copies remain identifiable by snapshot ID
and a residual flag; no user checkout is recursively removed. Inspect inventories
the whole isolated root and permits only changes within the original selection.
The provider currently issues inspection capability through a private same-instance
WeakMap; process restart recovery is not implemented or silently inferred.

Default physical copy bounds are50,000 entries,2GiB total,1GiB per file and depth100,
with explicit configurable limits and a100,000-entry manifest safety ceiling.
Bounds fail rather than truncate. These are filesystem resource controls, not
new task-round, model-call, token or money limits. Larger-tree throughput and
production retention/growth remain unaccepted. Known path exclusions do not
identify arbitrary secrets inside selected source text. Directory permissions and
Node path/inode/O_NOFOLLOW checks do not replace an OS sandbox; a changing live
tree is not a filesystem-wide atomic snapshot.

Diff artifacts validate both complete manifest hashes and identical selection,
retain content/mode/type/add/delete changes, and pair renames only for unique
matching content digests and lengths. Ambiguous repeated bytes stay add/delete;
case-only renames retain an explicit marker. Artifacts are frozen and contain no
file bodies or absolute roots, and cannot apply files. Cross-review reproduced a
scope defect: selecting one file also permitted replacing/deleting its structural
parent. Validator and real inspection now reject a non-directory ancestor, and
diff omits operations on merely structural ancestors. Parent disappearance after
deleting the selected file does not authorize removal of unselected siblings.

History endpoints page20 original admissions or proposals using scope-bound
keyset cursors. They create no schema/defaults and perform no Host/model call.
Reports and proposal hashes are checked; runtime status alone never establishes
accepted. Existing canonical finalization must match the current continuation,
owner review/certificate, frozen report/candidate and native completion/message.
Corrupt proof produces a bounded error. The UI uses escaped text and scope-safe
reads, shows coverage/limitations and separates execution/business/accepted state.
It does not directly load raw source bodies or trusted roots; model summaries may
themselves quote source text, so this is not content redaction or DLP.

Targeted verification: snapshot15, diff8 (including actual2MiB binary copy/edit/
inspection and a5,000-change ambiguous-content group), history11 and UI169 pass.
Final root32/build and real built-browser policy/history scenario pass: actual
original admission/source read/inspection step/21 proposals/report, proposal pages
20→1→20, escaped HTML, no raw source body, accepted:false and zero page errors.
Native idle in that browser fixture is controlled synthetic evidence. Separately,
three actual pinned official DSH SDK cases pass (28.02 seconds,18 scripted local
Messages requests), including original owner review/native publication, restart,
input continuation and history accepted:true for the exact native result. These
are SDK/scripted-model evidence, not real-provider or production acceptance.

Final full Gateway verification:1497 cases,1490 passed,seven existing/opt-in
skips,zero failures (190.90 seconds); Windows Gateway build passes. Root32,
UI169, final built-browser, selected SDK3, disclosure6,805-file preflight and
Brain links pass. Independent cross-review identified the ancestor-scope defect
before publication; red/green tests and a second review confirm that specific
issue closed. All remaining cycle authority/recovery/Git/DSH/apply/rollout and
full26 requirements above remain open. No execution or production switch changes.
