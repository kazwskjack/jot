# Changelog

## Unreleased

- Freeze new original-lead model/tool calls while a trusted host verifies durable quiescence and transfers control.
- Expose the existing trusted handoff admission hook in formal native-role setup without enabling it by default.

- Store terminal batch-operation facts atomically in native child closure receipts and reject conflicting retries.
- Require stored operation evidence to match every recognized batch call before native recovery.

- Add an explicit scoped read-only leaf observer for native member closure, with permission checks before and after the original operation lookup.
- Include the observer in the adapter package and test actual packed-module loading.

- Refuse native member closure for acknowledged background web batches until a trusted observer provides complete terminal outcomes for the original Session and tool call.
- Validate optional operation observers in formal native-role setup; single-item batches require reconciliation too.

- Persist validated web-operation status and item outcomes alongside progress revisions.
- Prevent task handoff while an observed web operation is running or has unresolved item outcomes.
- Migrate older operation cursors without assuming that their work completed; ignore stale observations.
- Require explicit accepted counts and complete unique item manifests before an observed operation can release a handoff barrier.
- Add an authenticated original-task handoff management transport with atomic receiver binding, rollback and fixed conflict receipts; native execution orchestration remains pending.
- Add optional trusted handoff admission before native member model selection, with an actual installed-SDK task-step and return-to-lead verification probe.

Native-host orchestration and provider-side effect reconciliation are still required before enabling production handoff.

## 0.1.0 code preview

- Portable local Agent with streaming model calls, bounded workers and tool rounds.
- Durable conversations, idempotent message acceptance and replayable events.
- Operation-scoped approvals, cancellation and explicit restart interruption.
- Allowlisted page reading, optional search/browser tools and new text-file delivery.
- Dark/light React interface and clearly synthetic research, approval and delivery previews.
- Extended gateway contracts/workers and a separately configured DSH Session adapter.
- Deployment, technology, Agent and contributor documentation.

This is a code preview, not a claim of model-backed deployment or sustained load certification. Optional integrations need their own services and acceptance checks.
