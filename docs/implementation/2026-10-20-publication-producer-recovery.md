# Original file-publication producer and interrupted recovery

## Architecture and code

DSH continues to own planning and native Goal lifecycle. This change connects
the existing approved publication intent to a foreground producer in the same
Gateway database and workspace coordinator. It adds no planner, task queue,
parallel workspace lock, model invocation or public Apply endpoint.

| Code | Responsibility | Why this boundary exists |
| --- | --- | --- |
| `packages/session-adapter/checkpoint.js`: `verifyHeldSessionCheckpoint` | Read the original canonical header/event prefix from actual persistence while maintenance is already held. | The ordinary idle-waiting wrapper would wait for its own maintenance callback. Readback must not rewind history, restore a Goal or fabricate child-parent bindings. |
| `packages/session-adapter/native-workspace-barrier.js` and `native-workspace-source.js` | Retain private original headers and expose checkpoint verification only through the existing ephemeral Host context. | A Session ID or matching directory is insufficient; serialized copies and foreign family members cannot acquire that context. |
| `packages/gateway/src/persistent-tasks/finalized-work-sources.ts` | Carry the original completed checkpoint in private native placement. | The checkpoint comes from the accepted finalization and stored native proof, not a caller-selected receipt or latest mutable tree. Public source summaries still omit host paths. |
| `work-publication-producer.ts` | Verify original history, claim/renew the original Worker lease namespace, prepare exact immutable bytes and call the configured file kernel. | Task acceptance alone never authorizes a new physical effect. Every effect retains the approved review, owner, held family and exact Worker generation. |
| `work-publication-journal.ts` | Keep one append-only, hash-linked journal in the original database for start, preparation, per-step intent/effect, application, finish and explicit owner disposition. | Persist intention before writing. A file effect cannot be rolled back by a failed SQL transaction, so missing acknowledgement remains unknown rather than becoming permission to retry. |
| `work-publication-executions.ts` | Historical status, foreground execution and explicit owner settlement commands. | Separate a known recorded application from an uncertain effect and from completion of the post-native reservation settlement. Commands use an exact journal digest and explicit acknowledgement. |
| `packages/gateway/src/workbench/workspace-coordination.ts` | Settle the same original reservation using publication-specific journal evidence. | Index-only proof cannot release file publication. Worker expiry alone cannot establish an effect or authorize releasing its workspace. |

The producer uses the existing `ga_worker_leases` table and the configured
Git-binding resource namespace. It never resumes the old completed task as
execution authority. No SQL transaction spans an `await`; actual synchronous
effects and their receipts are fenced inside short original transactions.

## Actual execution and recovery

1. Read the original admitted operation and exact approved review. Reserve and
   freeze its original native family through the existing Host.
2. Verify the producing Session retains the original completed checkpoint
   prefix. Later balanced history is allowed; a same-name history with a
   different prefix is refused before a producer or Worker lease starts.
3. Claim the original Worker resource and record its exact generation. Persist
   preparation and each directory/staging/publication intent before the effect.
4. Record actual file facts after each effect. Preserve the original index,
   HEAD, source snapshot and unrelated target files. Verify actual permission
   mode against the plan, including Windows' reported mode semantics.
5. Record application and producer finish. Release the Worker lease, drain the
   actual native callback, then settle the original workspace reservation.
6. On error or process exit, preserve the journal and files. A new process can
   read status without installing schema, recreating a task or replaying writes.

The journal validates contiguous sequence numbers, predecessor hashes, exact
original execution/review bindings, the ordered preparation plan, matching
intent/effect pairs and the final receipt. Nested paths derive all required
parents beneath the first absent ancestor; every created parent must exist as
a directory in the original inspected result manifest. Directory ordering uses
stable ordinal comparison, not process locale.

The existing Git module's non-object metadata witness is reused rather than
scanning the object cache at every file step. Unrelated content-addressed object
growth is allowed. Object-directory identity, repository/configuration/index
and reference changes remain checked. Windows permission-mode expectations
reflect actual platform behavior; this does not install or relax system ACLs.

## Explicit owner commands

`settlePublication` requires the original owner, operation ID, a request ID,
the exact expected journal digest, an explicit acknowledgement and one action:

- `confirm_recorded`: close an application whose complete result is already
  durably recorded, including interruption before producer-finish settlement.
- `abandon_unknown`: acknowledge an uncertain operation and close its hold
  while preserving every file and receipt. This does not claim rollback,
  successful application or absence of a physical effect.

Both actions obtain fresh original native custody. A live or replacement Worker
lease is not removed. Only the original expired lease can be fenced during an
explicit resolution. Revoking the old review does not grant another write, but
does not prevent its owner from resolving retained uncertainty. Started-operation
family inventory is therefore historical evidence; the actual producer still
checks current approval separately at every effect.

A lost resolution acknowledgement resumes only the exact recorded command.
It does not append a second disposition or skip the remaining native drain and
reservation settlement. Unknown effects can never use the unstarted-release path.

## Verification and remaining boundary

Focused Windows tests have exercised actual installed DSH Session/Goal/storage,
the original Gateway task finalization, real configured repositories and zero
model calls. The fixture uses a synthetic balanced turn with real Goal mutations
and durable readback; this is not model-driven planning acceptance. Tests cover
actual file modification and nested-file addition,
wrong native prefix, revoked review, lease replacement, database failure after
physical writing, immutable/corrupt journal detection, owner acknowledgement,
and lost settlement acknowledgement. Separate child processes exited before
and after physical publication; a new connection retained uncertainty without
replaying the write. Platform-mode and Git-cache regressions were reproduced
before their fixes.

The final Windows Gateway regression completed with 2,195 tests: 2,188 passed,
7 conditional skips, zero failures and zero cancellations. Available installed
DSH SDK scenarios were explicitly enabled. All 611 enumerated Gateway source,
test, contract, script, template and package files matched their pre-run hashes.
Earlier source-custody-only results are not substituted for this producer gate.

The root suite passed 67 tests, the workbench UI suite passed 253, and the
Session adapter suite passed 818 with 29 optional skips and no failures or
cancellations. Gateway typecheck/build and frontend build completed successfully.
The six public-verifier tests passed; the source-tree review scanned 1,184 files
with no findings. These are synthetic/local acceptance results, with the SDK
fixture limitations described above; they do not establish live-provider or
production behavior.

Still open: resolving multiple historical isolated native roots in a project,
cross-process Host transport and public owner Apply/recovery controls, broader
binary/generated/shared/delete/rename/mode operations, and non-Windows/provider/
deployment acceptance. These tests do not authorize production activation or
complete the full 26-capability and portable Chat/Work goals.
