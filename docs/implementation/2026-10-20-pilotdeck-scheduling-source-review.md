# Scheduling source review and integration boundary

This is a source comparison for capability 09, not a claim of completed parity.
The inspected PilotDeck reference is commit
`783499ffdb2d501bf590b2e035acd027a882df10`, AGPL-3.0. No source is copied by
this review. Jot retains its original persistent task IDs, occurrence ledger,
owner/version checks, Worker leases and DSH execution.

## Source, behavior and existing counterpart

| Pinned upstream code | Actual behavior and design reason | Existing Jot counterpart | Reuse decision |
| --- | --- | --- | --- |
| `src/cron/protocol/types.ts`, `runtime/CronSchedule.ts` | Accepts an absolute one-time schedule, a relative delay, or a five-field cron expression with timezone. Minute-aligned calendar matching supports lists, ranges and steps; Sunday 7 normalizes to 0. The two restricted day fields use Unix OR semantics. A special leap-day search avoids missing the next leap year within the ordinary one-year search horizon. These semantics are visible in code and comments. | `persistent-tasks/service.ts` normalizes once, interval and page-change triggers, delegates daily/weekly to `calendar.ts`, and also supports dialogue/discovery sources. It currently has no general cron-expression trigger. | Retain existing trigger normalization and occurrence calculation. General cron expressions and an explicit relative-delay input are genuine interface gaps; daily/weekly support does not close them. Add only the missing schedule forms to the original service, rather than installing a second scheduler. |
| `runtime/CronScheduler.ts`: `start`, `recalculateAllNextRuns`, `tick`, `delayTask` | Starts once, polls every minute, drains an in-flight tick on stop and defers due tasks when active-run capacity is full. Schedule computation version 3 recalculates affected version-2 day-field caches while retaining a pending earlier/deferred run. The comments explain that OR can bring a run forward without pushing an existing run back. | `persistent-tasks/scheduler.ts:maintainWorkbench` separates cleanup from execution readiness. `PersistentTaskService.tick` rereads task status/version/generation/due before admission, writes the next due time in the original transaction, and coalesces missed interval runs. Calendar advancement is strictly after the later of now and due. | Keep original Worker maintenance and transactional task checks. Reuse the idea of explicit schedule-computation versions if new expression semantics require migration. Do not copy a one-minute polling constant as a new product latency guarantee or replace original cross-process fencing with an in-process active counter. |
| `runtime/CronFire.ts:runTask` | Registers active execution, conditionally changes the exact scheduled snapshot to running, records native events and forwards delivery. Its submitted turn uses `bypassPermissions`. | Original task admission, native Goal, approvals, budget accounting, outputs and notification receipts already have separate authorities. | Reuse the separation of schedule claim, execution events and delivery as a comparison criterion. Do not transfer `bypassPermissions`: a due time never grants tool, browser, file or message permission in Jot. |
| `storage/CronTaskStore.ts` | Stores task JSON, append-only run/event history and serialized file mutations. The visible mutation-tail map is process-local. | Original SQLite task and occurrence records, original version/generation checks and Worker leases. | Retain Jot storage and IDs. Copying the upstream JSON store would create competing authority and would not establish cross-process exclusion. Preserve useful owner-readable task/run projections without treating a projected file as the database. |
| `runtime/CronRuntime.ts:updateTask`, `stopTask`, `runTaskNow`; `ui/server/routes/cron-jobs.js:createCronUpdateHandler` | Uses expected revisions, refuses editing a running task, exposes manual run/stop/delete and maps running/conflict/not-found distinctly in the Web route. | Original task `update`, `pause`, `resume`, archive and active-run cancellation through its existing APIs. | Keep original CAS and cancellation. Compare manual-run/edit UX and surface actual conflicts instead of silently overwriting newer task state. Source review alone does not prove this complete UI path. |

Jot paths in this table are relative to `packages/gateway/src/`; upstream paths
are relative to the pinned source checkout. The storage/execution reasons in
the last column are integration conclusions drawn from the inspected code.

## Existing calendar behavior worth retaining

`calendar.ts` validates IANA timezone and wall-clock input, normalizes weekly
days, and inverts wall time using offsets on both sides of a timezone transition.
Its documented rules select the earliest occurrence of a repeated local time,
advance a missing wall time to the gap boundary, and skip a completely missing
calendar date. The implementation explicitly accommodates half-hour changes
and date-line shifts. This is a reason to retain its daily/weekly behavior,
not to claim that it is equivalent to every upstream cron expression.

Relevant existing executable entry points are
`test/persistent-tasks/calendar.test.mjs`, `calendar-service.test.mjs`,
`scheduler.test.mjs`, `service.test.mjs`, `coordinator.test.mjs` and
`test/contracts/calendar.test.mjs`. Their existence is not execution evidence;
results must be recorded by the actual current-tree gate.

## Required missing-path implementation and acceptance

1. Add explicit cron/delay forms to the existing versioned trigger contract,
   validation, API/BFF and task editor. Resolve a relative delay once at original
   acceptance and persist that exact due time; retries or restart must not
   recompute it from a new wall clock.
2. Preserve original occurrence keys and schedule revision. Compute the next
   expression occurrence through the existing task tick, with current owner,
   role, status, generation, cancellation and native/budget readiness checks.
   No independent timer, task store or execution loop is introduced.
3. Define expression/timezone/DST semantics explicitly before enabling them.
   Include strict malformed-token rejection, lists/ranges/steps, Sunday aliases,
   restricted-day OR, leap day and dates with no valid future occurrence.
   Do not silently reinterpret unsupported expressions as an interval.
4. Test duplicate ticks across two original database connections, restart before
   and after occurrence commit, missed-run coalescing, pending capacity deferral,
   task edit/version conflict and pause/stop during an active run. Original
   unknown effects and notification receipts must remain unreplayed.
5. Verify actual UI create/edit/manual-run/stop and original DSH execution with
   one canonical task/run result. Keep synthetic clock tests, live-provider
   behavior and deployment acceptance separate.

The above items remain open. This comparison advances source/function/design
coverage; it does not mark capability 09, the 26-capability ledger or the portable
Chat/Work product complete.
