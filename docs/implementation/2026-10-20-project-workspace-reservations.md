# Original project workspace reservations

Continues the [Git workspace coordination plan](../superpowers/plans/2026-10-19-git-index-http-workflow.md)
and the [native maintenance primitive](2026-10-20-native-workspace-barrier.md).
This is coordination groundwork, not activation of the complete Git write path.

## Actual owning paths

The product database now records immutable project reservations and append-only
pre-dispatch releases. The same records are read by the existing
`HarnessCoordinator` claim transaction and `WorkbenchService.writeFile`
transaction. There is no new task scheduler or alternative planner.

`GitIndexExecutions.reserveWorkspace` verifies current project ownership, the
original admitted execution and receipt, an unstarted original producer, current
review authority and the configured repository binding. It then reserves the
project inside the same immediate SQLite transaction. The reservation remains
separate from approval, executor custody and permission to perform Git effects.
The internal source functions are not HTTP/tool methods and carry no user-facing
execution grant.

While held:

- The original Worker skips queued/recoverable runs for that owner/project and
  may claim another unreserved project normally. Its existing priority, budget
  and lease rules still apply.
- Database activation triggers prevent direct run insertion/transition into an
  executing state from bypassing the fence. A concurrent database writer cannot
  pass through a reservation that has not committed or rolled back.
- Shared file writes check the fence and current ownership before creating the
  source root, directories or immutable blobs, within their original CAS
  transaction. Existing file bytes and versions remain readable and unchanged.
- Git's original claim and authority checks reject uncoordinated effects. Merely
  acquiring the reservation cannot dispatch the physical operation.

An active logical run blocks reservation even when its Worker lease has expired.
Expiry does not establish that its native producer or tools have stopped. Legacy
conversations without a project binding are treated as uncertain owner scope:
an active one blocks reservation; a queued one cannot be claimed through any
held reservation of that owner. This avoids guessing its eventual project.

There is no TTL that silently frees a reservation after process loss. The current
release method is deliberately limited to original admitted executions with no
producer, preparation, dispatch or outcome record. It rechecks current ownership
and repository binding. A released reservation is historical and cannot be
rearmed; it is not a fresh authorization or a retry of the original operation.
Known or unknown producer activity needs the separate original drain/effect
reconciliation path before a later implementation may release its workspace.

## Evidence so far

Fourteen focused product-database/real-Git tests pass, including:

- Original receipt and current ownership checks; reservation is not execution.
- Actual Worker selection, a competing SQLite connection and direct activation.
- Existing active runs with expired leases, and legacy unbound conversations.
- Cross-connection shared writes, unchanged file content and no directory
  allocation for a refused first write.
- Reservation rollback, database reopening, immutable reservation/release rows,
  idempotent pre-dispatch release and refusal to rearm a closed reservation.
- Refusal to replace an original reservation by changing its record ID while
  reusing the unique original-operation identity.

The tests were added before implementation. Additional failing cases exposed
source-root allocation before the fence and legacy unbound-project bypasses;
both were fixed. The additional unique-operation replacement test also failed
before its immutable-identity trigger was added. Gateway type checking and the
local Windows build pass against the final source.

The complete Gateway run ended with 2,046 passes, zero failures/cancellations and
seven existing conditional skips (2,053 total). The final three-line replacement
guard and its new case were added while that run was in progress; its reservation
test process had already loaded the preceding 13-case version. The separate
14-case suite was rerun against the final source with zero failures or skips.
These are distinct evidence scopes, not a claim that the full run was frozen at
the final revision. The standalone 67-test suite and local frontend build also
pass. No real-provider or production acceptance is inferred from these results.

## Still required before write activation

Join this original project reservation to authoritative resident **and cold**
native membership and the host maintenance barrier. Keep original Worker/run/
Session/role custody and cancellation through acquisition, physical dispatch,
publication, drain and release. Add settled/unknown-producer release only with
original evidence; do not free a hold solely from a terminal logical run or an
idle snapshot.

Configured Git repositories, logical blob source roots and isolated native work
directories remain different physical roots. Their original association and
publication boundary still require validation. Checkpoint filesystem restore and
mixed-version producer drain are also unfinished. The current reservation source
is original Git index execution; this record does not claim checkpoint restore
has already been wired into it.

No new mutation HTTP route, browser control, arbitrary command, production flag
or deployed service is enabled by this increment. The full coordination plan and
capability ledger remain open until the actual end-to-end path passes.
