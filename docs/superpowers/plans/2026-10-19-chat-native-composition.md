# Close the original Chat UI/native composition

This continues the unchecked extended integration gate in the portable Chat/Work
plan. DSH remains the sole planner. Do not replace native readiness, execution,
owner binding, leases, immutable command receipts or accounting with a browser
fixture. Local scripted model responses prove integration, not provider quality.

## Observed failures

1. The Gateway Session client calls `/v1/conversation-modes/readiness`, while the
   original adapter has no matching route. A real UI/BFF/Gateway/SDK case exposes
   the missing route; previous UI/native tests explicitly supplied readiness
   fixtures and therefore could not prove this composition.
2. After adding the actual readiness boundary, the model's short initial text
   still does not appear before model completion. The Runner buffers by size
   and checks elapsed time only when another chunk arrives. One small chunk
   followed by a waiting stream never triggers that time check. A held-stream
   Runner regression reproduces the missing early delta.

## Implementation and acceptance

- Add an internally authenticated, exact-empty-body readiness read. Default off.
  Explicit enablement requires accepted Chat policy, the matching actually
  mounted preset revision, original model selection and input admission, bounded
  context and read-only Web allowance composition. Return detached policy only;
  no credential bodies, Session activation, inference or permission changes.
  Include the helper in the adapter package manifest. Keep public production
  activation and external-provider readiness separate.
- Add a real timed delta flush, retaining configured batching. Serialize timer
  and event-triggered projections so delta indexes, ordering and contents cannot
  race. Stop the timer and drain owned work at every exit. Projection errors
  must fail/cancel the original operation rather than silently lose text. Do not
  publish a canonical final answer from partial output or flush after cancel.
- Reuse actual React picker/conversation, original local BFF, original Gateway
  routes/event streams, SQLite, Worker, Session client and installed pinned SDK.
  Obtain actual adapter readiness/catalog metadata. Create and send through UI;
  hold the scripted provider after initial text. Observe early text while no
  canonical answer exists, exclude mode switching while active, finish one
  original answer, reload and verify exactly that answer.
- Preserve the previous native fixture variants and run their serial SDK
  regression. Separately test timed flush, batching, cancellation, delayed
  projection and error/drain behavior. Run full Gateway/adapter/root/UI tests,
  typecheck/build, then source/staged/history audits and explicit feature-branch
  publication. Record all skips and remaining external-provider/steering/upload
  acceptance honestly. Do not mark the entire portable gate or capability ledger
  complete from this single composition case.

## Executed local evidence

The [implementation record](../../implementation/2026-10-19-chat-native-composition.md)
records observed failures, runtime fixes and the successful complete mobile
composition. Final local checks: Gateway 1,826 passed/seven explicit skips;
Adapter 672 passed/25 explicit gated skips; root 67 and UI 233 passed without
skips; typecheck and both local builds passed. Actual installed-SDK serial Chat
regression passed 20 cases, and the selected original Work compaction case passed,
all without skips. A final focused mobile rerun also passed after optional browser
imports were made lazy. These are scripted-provider local integration facts.

External providers/cache/billing, UI steering/uncertain sends/attachments and the
full parent capability ledger remain open. No production activation is made by
this increment. Final privacy review and exact remote publication are separate
release checks.
