---
id: native-goal-boundary
title: Keep native Goal state and continuation in DSH
category: decision
status: active
created: "2026-10-16T11:44:16"
updated: "2026-10-16T14:41:55"
---

<!-- compiled_truth -->
DSH remains the authority for ordinary Goal state, automatic rounds, planning and completion. Gateway projections and human control receipts do not create another scheduler or grant tool permission. Human pause/stop and the original owner, Session, high reasoning and cumulative accounting remain authoritative. Role and persistent-task Goals keep their existing scoped paths.

Persisted Goal reads use official cold projections without creating an Agent or rearming activation. Explicit cold pause/clear require an ordinary preset, empty durable inbox and contiguous closed history, then official resolver/maintenance/persistence. Pending input and unsupported interrupted history are recovery requirements, not proof that there is no Goal.

Human resume is a durable intent in the original database, run queue, outbox and Coordinator lease, not a model prompt. Its continuation run has null input_message_id plus explicit goal_control_id and source-run lineage. The original user message and attachments are not replayed; candidate attribution follows the source run. Null input prevents a historical input-message join from obtaining the source prompt, but does not prove an old Worker can execute the new job. The whole consumer pool still needs upgrading before rollout.

Public resume admission atomically commits the original request, queued run and exact-key 202 acceptance receipt. Acceptance, native applied receipt and Goal completion are different facts. Lost replies recover only the original durable receipt; a typed pre-admission reservation can retry its original request without a duplicate job. Readiness reports configured capability and original queue facts, not a complete rollout audit or recoverability guarantee.

The trusted Host subscribes to official follow and parks its iterator at the opening snapshot before restoring an Agent. In the locked SDK, advancing beyond that snapshot promotes a prepared Session; preflight and exact native maintenance must admit that advancement. Cold observations and rejected pending input must not create an Agent. Native CAS, persistence flush and an applied receipt precede model execution. Every original step/tool/model path checks the live observer, original lease and current Goal identity; an old receipt cannot authorize a replacement Goal. Same-Goal completion still allows its closing answer. New Hosts/followers cannot rearm an old unknown dispatch or receipt.

The UI follows accepted original runs separately from validated native Goal phase and continues polling while restoration is queued. Unknown replies preserve the exact request in the current page and warn before navigation. Forced browser-crash recovery for unacknowledged requests, all-boundary process reconciliation, pending/interrupted-history recovery and production acceptance remain incomplete. Gateway admission and Host observer switches default off until complete consumer rollout and remaining gates pass. Real locked-SDK/scripted-model verification is wiring evidence, not real-provider quality or production accounting.

Only the original trusted live attempt before invoking native resume may attest an immutable not-called rejection. The Gateway records its fixed reason with the exact original run/Session/lease; Worker and UI expose that reason without raw transport text. A lost begin acknowledgement can be reconciled as not-called only by that still-live attempt. Once native resume has been invoked, a thrown error, failed flush or lost applied acknowledgement is uncertain and cannot be reclassified from the current Goal alone. Disarm covers a native invocation that appended then threw. Actual isolated Host termination is tested after native flush and after applied commit, distinct from unit fault injection or exhaustive crash recovery.

Dispatch identity also includes a Host-generated immutable observer ID. Begin, applied and pre-native refusal bind that same ID, even within one unchanged Worker lease. A delayed old observer cannot reject or apply a replacement observer's dispatch. Existing uncertain/applied records gain a null observer field, never a retroactive execution grant; the original request and receipts remain unchanged.


## Timeline

- time: 2026-10-16T11:44:16
  kind: decision
  summary: "Created this page: Keep native Goal state and continuation in DSH"
  source: WORKBENCH.md
  affects: [native-goal-boundary]

- time: 2026-10-16T11:44:37
  kind: decision
  summary: Preserve owner scope and separate cold read from activation
  source: WORKBENCH.md
  affects: [native-goal-boundary]

- time: 2026-10-16T12:04:44
  kind: decision
  summary: Keep human resume attached to an observed product run and preserve uncertain receipts
  source: WORKBENCH.md
  affects: [native-goal-boundary]

- time: 2026-10-16T12:34:27
  kind: decision
  summary: Use official cold control maintenance and preserve recovery and observation boundaries
  source: WORKBENCH.md
  affects: [native-goal-boundary]

- time: 2026-10-16T13:08:08
  kind: decision
  summary: Keep explicit resume intent and native receipt in original run lineage without prompt replay
  source: docs/GOAL-CONTINUATION.md
  affects: [native-goal-boundary]

- time: 2026-10-16T13:27:49
  kind: decision
  summary: Keep the observed Host backend opt-in until public admission and recovery gates pass
  source: docs/GOAL-CONTINUATION.md
  affects: [native-goal-boundary]

- time: 2026-10-16T13:28:04
  kind: decision
  summary: Record implemented observer and native Runner while preserving remaining public recovery gates
  source: docs/GOAL-CONTINUATION.md
  affects: [native-goal-boundary]

- time: 2026-10-16T14:11:37
  kind: decision
  summary: Use atomic public acceptance and message-free original lineage while keeping recovery and rollout gates explicit
  source: docs/GOAL-CONTINUATION.md
  affects: [native-goal-boundary]

- time: 2026-10-16T14:30:32
  kind: decision
  summary: Gate official post-snapshot promotion and distinguish pre-native refusals from uncertain mutations
  source: docs/GOAL-CONTINUATION.md
  affects: [native-goal-boundary]

- time: 2026-10-16T14:30:32
  kind: reversal
  summary: "Official follow is not intrinsically cold-safe after its opening snapshot; hold its subscribed iterator until maintenance admission"
  source: docs/GOAL-CONTINUATION.md
  affects: [native-goal-boundary]

- time: 2026-10-16T14:41:55
  kind: decision
  summary: Fence delayed control receipts to their original observer within the same Worker lease
  source: docs/GOAL-CONTINUATION.md
  affects: [native-goal-boundary]
