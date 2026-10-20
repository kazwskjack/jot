# Original publication: mobile review, Apply and recovery

## Product behavior

An owned task occurrence that is `succeeded` and `completed`, with its original
conversation and run IDs, exposes **查看工作区改动** in its execution details.
Opening it resolves the original owned conversation project and finalized source;
it cannot infer an agent's current project or grant write authority.

The complete isolated-work inventory includes unsupported changes. Eligible
text-file choices are explicit, paged by 50 and limited to 100 per review. The
user generates a target review, inspects before/after text, acknowledges it,
approves it, admits an execution and explicitly applies it. Admission is shown
as **已受理，尚未应用**. All content renders as text. Original DSH planning,
owner checks, source receipts, target witnesses, native custody and Worker
fencing remain authoritative. Browser commands contain no host root or secret.

## History and response loss

`GET /v1/projects/:projectId/work-publication-sources/:runId/history` pages the
original intent table, at most 25 items per page. Optional `before` is an original
same-source intent ID; extra parameters, foreign scope and unrelated cursors
refuse. Each item contains original review metadata plus immutable acceptance
and separately verified current status, when present. There is no new history
store, dispatch or source write. Reload and other-device reads can find existing
records. Selecting an older page retains that option while refreshing its actual
current review; display metadata grants no approval.

Prepare/approve/cancel/admit retain the exact body and idempotency key after lost
acknowledgement. Workbench navigation, task-detail close and occurrence selection
stay locked while a command is unconfirmed. Dispatch/settle never auto-retry.
Uncertain I/O triggers original-record reads; recovery needs explicit user
acknowledgement. Recorded recovery commands retain their original ID and journal
CAS. Stopping a wait aborts it without promising native rollback. Only the
original current execution can establish successful application.

## Executed local evidence

- Eight helper cases cover source proofs, completed-occurrence entry, older
  history selection, state labels, recovery ID/CAS and atomic-only retries.
- A mobile browser with actual BFF/Gateway drops a real approval response,
  verifies identical retry, reloads acceptance, refuses unconfigured execution,
  and checks the actual task entry, navigation lock and read cancellation.
- A second mobile case uses the installed DSH SDK and a separate compiled
  original native Host, with zero model calls. The Host writes synthetic target
  bytes and exits after effect. The UI shows pending settlement; reload writes
  no journal. After confirming the process exited, the test expires only its
  exact synthetic lease and starts a fresh Host. Explicit confirmation settles
  the original execution. File device/inode/mtime and bytes show no second write.
- Both browser cases passed without skips. The parent lock regression first
  failed after the lost approval stopped loading, then passed after including
  the unconfirmed original command in the lock.
- Current-tree Gateway typecheck/build, frontend build and six disclosure
  verifier cases passed. The frozen-code root suite passed 67/67 and the complete
  UI suite passed 267/267 with the SDK enabled, including both actual browser
  cases. All nine changed transport cases passed. The frozen whole Gateway regression
  completed: 2231 tests, 2224 passed, seven conditional skips,
  zero failures/cancellations, with the SDK enabled and source hashes unchanged.

Only synthetic local data and isolated browser profiles were used. This does not
enable production Apply or prove deployed pool quiescence. Packaged operator
maintenance, broader platform/provider acceptance, final disclosure/remote
verification and the full PilotDeck/portable Chat/Work scope remain open.
