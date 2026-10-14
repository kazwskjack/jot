# Changelog

## Unreleased

- Persist validated web-operation status and item outcomes alongside progress revisions.
- Prevent task handoff while an observed web operation is running or has unresolved item outcomes.
- Migrate older operation cursors without assuming that their work completed; ignore stale observations.
- Require explicit accepted counts and complete unique item manifests before an observed operation can release a handoff barrier.

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
