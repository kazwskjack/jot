---
id: always-on-discovery
title: Keep project discovery in original DSH task boundaries
category: decision
status: active
created: "2026-10-17T03:43:02"
updated: "2026-10-17T04:41:31"
---

<!-- compiled_truth -->
Project discovery covers the full lifecycle: explicit owner project/workspace/role policy, factual idle/source collection, original occurrence admission, DSH planning and native task/Goal execution, source-backed plans, isolated work cycles, verified reports, reviewed diff/apply, pause/stop and deployment recovery. Configured persistent tasks are not equivalent to proactive discovery.

DSH remains the sole planner. Reuse Gateway ownership, role epochs, permissions, original runs/leases, budgets, receipts and channel outbox. Do not transplant the reference implementation's unattended bypassPermissions or treat absent channel leases as proof of native idle. Pure gate results are non-authorizing advice; fresh live authorities must be revalidated transactionally before admission. Unknown/stale facts block. User pause/stop and unknown model/tool outcomes stay authoritative.

Default policy is off. Discover-only produces proposals; discover-and-work still requires bounded owned workspace/tool authority. Applying an isolated cycle to the original project always requires explicit review of a frozen diff/base and idempotent owner confirmation. No automatic new planner, ordinary-chat prompt replay, fresh-budget escape or resurrection of revoked memory/permission.

Honor explicit unlimited budgets. Persistent tasks now accept explicit public max_runs:null, with capability-gated UI and an exact internal (unlimited,0) tuple in the original table; finite/default100 are retained. Migration preserves original IDs, counts, states and request keys. Zero alone is not unlimited: tuple guards reject inconsistent writes and the known prior numeric admission guard refuses unsupported new tasks. Full old-worker rollout/rollback still needs acceptance. Changing limits never resets usage or automatically resumes an exhausted/paused task. Model budgets, native Goal, mailbox quotas and physical background capacity remain separate. Null in discovery gate cycle capacity means confirmed unlimited policy, never missing or guessed facts. This prerequisite does not install the discovery pipeline.

The initial pure eligibility module and the opt-in current-Host native observation protocol are implemented. The project activity source adapter combines original scoped SQL and existing workspace facts with the strict authenticated Host client, releasing read transactions before IO and rejecting drift or expired observations. These are non-authorizing source components, not a running discovery feature. Existing budget/capacity and reconciliation facts, durable owner policy/signal/occurrence integration, DSH planning/execution/report, isolated workspace/apply, UI, real-provider and deployment acceptance remain incomplete. The source review and entire implementation sequence live in docs/superpowers/plans/2026-10-17-always-on-discovery.md. Full PilotDeck capability scope is unchanged.


## Timeline

- time: 2026-10-17T03:43:02
  kind: decision
  summary: "Created this page: Keep project discovery in original DSH task boundaries"
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T03:43:02
  kind: decision
  summary: "Define complete discovery integration, authority boundaries and the explicit unlimited-run contract gap."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T03:44:45
  kind: evidence
  summary: "Source audit identified persistent-task finite limits in storage, admission, exhaustion SQL, route/OpenAPI schemas, form conversion/resume controls and durable save recovery. Mailbox max_runs is a distinct policy and must not be changed through a broad replacement. The new 30-case pure gate contract is not a live scheduler or collector."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T04:01:39
  kind: decision
  summary: "Persistent-task unlimited runs use explicit public max_runs:null and an exact internal (unlimited,0) tuple; finite/default100 remain unchanged. New mode is capability-gated in UI and tuple-guarded in the original table. The known earlier numeric guard refuses zero, not proof of full mixed-fleet availability. Pause, native Goal, model budget, mailbox quotas and unknown outcomes remain separate."
  source: docs/superpowers/plans/2026-10-17-unlimited-task-runs.md
  affects: [always-on-discovery]

- time: 2026-10-17T04:04:05
  kind: decision
  summary: "Implement explicit unlimited task-run contract while preserving finite defaults, original counts/receipts, conservative legacy refusal and all other authority gates."
  source: docs/superpowers/plans/2026-10-17-unlimited-task-runs.md
  affects: [always-on-discovery]

- time: 2026-10-17T04:29:01
  kind: decision
  summary: "Current-Host idle observations are opt-in, read-only and non-authorizing. Missing Sessions remain unknown; cold active Goals remain busy. Actual project collection and transactional admission must still revalidate owner policy, all bindings, freshness, budgets and execution authority."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T04:30:50
  kind: evidence
  summary: "Opt-in current-Host observation verified through the real pinned SDK HTTP adapter and Gateway client before/after restart; paused Goal unchanged, zero restarted Agent creation and model calls. Missing Session stays unknown. Full project discovery and production acceptance remain incomplete."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T04:39:19
  kind: decision
  summary: "Project activity collection reads original scoped project/role/conversation/run/child/input metadata and existing workspace readiness without creating records or directories. Release read transactions before Host IO; recheck sources and oldest observation freshness afterward. Missing bindings remain unknown. Terminal run timestamps are cooldown hints, never successful completion or budget/execution authority."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T04:41:31
  kind: decision
  summary: Record completed read-only source components while retaining the full unfinished discovery lifecycle.
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]
