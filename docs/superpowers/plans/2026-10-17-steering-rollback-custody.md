# Original steering custody across configuration rollback

Continuation of the approved steering/recovery and consumer-upgrade work. DSH
remains the planner; this work creates no execution authority or alternative queue.

## Reproduced defect

The original steering request can enter the native call and lose its response.
If the parent ends and the dispatcher restarts without the steering option,
the existing legacy branch enqueues the same supplement as a fresh run. The
new regression observed two product runs instead of one. A pending command is
not evidence that native input was never accepted.

## Implementation and acceptance

1. Add a hash-only immutable custody record in the existing Gateway database,
   bound to original command/run/owner/conversation/Session, client message ID
   and command/content hashes. Persist after existing live binding checks but
   before calling native steering. The record means only that fallback is
   forbidden, not that a call happened, succeeded, was billed or is safe to retry.
2. A current dispatcher must retain fenced terminal commands even if its new
   runtime option is disabled. Historical reconciliation remains opt-in and
   must use its existing original-scope proof. Do not mark pending input applied.
3. A database insert guard must reject the legacy fallback's new human message
   for a reserved client ID in the original conversation. Original deterministic
   command-message publication remains possible. Guard command identity against
   edits that would evade custody. Preserve existing unreserved legacy behavior.
4. Test lost replies, option rollback, direct legacy enqueue, original publication,
   reopen, immutable identity and owner/conversation scope. Run Gateway tests/build,
   affected installed SDK cases, root tests/build and public disclosure review.
5. Document and upload only reviewed source/docs. Keep production switches off.

This cannot undo an already-issued old unbound prompt, fence an old Host's own
native API, or certify an upgraded fleet. Old execution producers/consumers must
still be stopped and drained before rollout. Legacy dispatchers may report the
new database refusal until upgraded; controlled refusal is not mixed-fleet
availability. Full event/consumer deployment, real-provider accounting and the
complete PilotDeck inventory remain required.

## Verified local evidence

The initial regression failed with two runs instead of one. The fixed dispatcher
commits custody in an immediate transaction after the existing live binding
checks, before calling native steering. Its terminal and live paths refuse
legacy fallback for reserved commands even after option rollback. Custody stores
identity and hashes, without copying the supplement's text or attachments.
The source binding query itself remains read-only.

The final dispatcher suite passes 20 cases. It includes pinned older method
bodies and their source/import/hash/MIT provenance. The negative control creates
two runs without custody; with custody the older dispatcher's original enqueue
fails atomically and leaves one run plus the original pending command. Supporting
repositories are current, so this is not an entire old binary/fleet acceptance.
Other cases cover live unbound-prompt refusal, wrong classification, reopen,
identity mutation/replacement/deletion, original deterministic publication,
same-client isolation across conversations, cancellation, parent deletion,
foreign lease refusal and changed Session refusal. Unreserved legacy behavior
is retained, rather than silently retroactively claiming it used the new path.

Full Gateway verification passes 1301 tests total: 1295 passed, six existing
skips, zero failures (147.16 seconds), plus Windows Gateway build. The additional
changed-Session/foreign-lease case and expanded live wrong-classification
assertion were added after the full test process loaded this file; the final
20-case suite was rerun successfully. Production code did not change after the
full run. The three affected actual installed-SDK cases pass (60.83 seconds):
live lost acknowledgement, historical final publication and historical correction.
They retain existing assertions on original native/admission content and scripted
model calls. They use a local synthetic model/provider, not real billing or
production traffic. Root tests pass 32/32 with Windows build. Public regressions
pass 6/6; the working-tree scan covers 748 files and BRAIN links pass.

Production flags remain off. The full original scope, earlier unreserved/live
consumer migration, event rollback, actual providers/fees, output performance,
deployment acceptance and all PilotDeck capabilities remain unfinished.
