---
id: always-on-discovery
title: Keep project discovery in original DSH task boundaries
category: decision
status: active
created: "2026-10-17T03:43:02"
updated: "2026-10-17T05:48:00"
---

<!-- compiled_truth -->
Project discovery covers the full lifecycle: explicit owner project/workspace/role policy, factual idle/source collection, original occurrence admission, DSH planning and native task/Goal execution, source-backed plans, isolated work cycles, verified reports, reviewed diff/apply, pause/stop and deployment recovery. Configured persistent tasks are not equivalent to proactive discovery.

DSH remains the sole planner. Reuse Gateway ownership, role epochs, permissions, original runs/leases, budgets, receipts and channel outbox. Do not transplant the reference implementation's unattended bypassPermissions or treat absent channel leases as proof of native idle. Pure gate results are non-authorizing advice; fresh live authorities must be revalidated transactionally before admission. Unknown/stale facts block. User pause/stop and unknown model/tool outcomes stay authoritative.

Default policy is off. Discover-only produces proposals; discover-and-work still requires bounded owned workspace/tool authority. Applying an isolated cycle to the original project always requires explicit review of a frozen diff/base and idempotent owner confirmation. No automatic new planner, ordinary-chat prompt replay, fresh-budget escape or resurrection of revoked memory/permission.

Honor explicit unlimited budgets. Persistent tasks now accept explicit public max_runs:null, with capability-gated UI and an exact internal (unlimited,0) tuple in the original table; finite/default100 are retained. Migration preserves original IDs, counts, states and request keys. Zero alone is not unlimited: tuple guards reject inconsistent writes and the known prior numeric admission guard refuses unsupported new tasks. Full old-worker rollout/rollback still needs acceptance. Changing limits never resets usage or automatically resumes an exhausted/paused task. Model budgets, native Goal, mailbox quotas and physical background capacity remain separate. Null in discovery gate cycle capacity means confirmed unlimited policy, never missing or guessed facts. This prerequisite does not install the discovery pipeline.

The initial pure eligibility module and the opt-in current-Host native observation protocol are implemented. The project activity source adapter combines original scoped SQL and existing workspace facts with the strict authenticated Host client, releasing read transactions before IO and rejecting drift or expired observations. These are non-authorizing source components, not a running discovery feature. Durable owner policy configuration/control API and immutable internal signal storage are also implemented. Saving starts off; role drift revokes effective activity; only explicit owner enable can resume. Original atomic API receipts and immutable business revisions prevent duplicate writes after lost responses. Signals never resume paused/stopped policy and exclude self-generated origins. Original task-budget and Coordinator logical-capacity read observations are implemented without allocating calls, scopes, leases or another scheduler. Exact durable-root usage includes members; unknown and in-flight usage remain unresolved for a new occurrence. These observations are not execution authority or native/hardware readiness. Explicit owner enable now prepares one fixed original task/budget identity atomically with the policy command, with no due time or occurrence. Pause/stop/resume reuse it without resetting the accumulated run count. Generic mutations, timer and legacy occurrence paths are guarded; occurrence admission remains closed until its full protocol is verified. Remaining reconciliation facts, trusted watchers/provenance/coalescing, dormancy/reservation/original occurrence admission, DSH planning/execution/report, isolated workspace/apply, full policy/work-cycle UI, real-provider and deployment acceptance remain incomplete. The source review and entire implementation sequence live in docs/superpowers/plans/2026-10-17-always-on-discovery.md. Full PilotDeck capability scope is unchanged.

Trusted database source ingestion now runs on the existing ready Worker maintenance loop. It journals role-bound human input identity metadata and owned immutable file-version metadata without reading bodies/blobs, creating runs or reserving a model attempt. Original cumulative task budget lineage excludes recorded discovery-derived outputs across the project; unknown producers hold later versions of that path. Direct owned versions without producer records are base metadata, not human-authorship proof. Off/stopped/revoked policies do not collect; paused policies never resume. Bounded drain batches are not task/token caps. Physical filesystem watchers, edited-message revisions, coalescing/dormancy, transactional occurrence reservations/admission and all remaining DSH/work-cycle/apply/UI/provider/rollout acceptance remain open. The SQL occurrence guard is still closed.


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

- time: 2026-10-17T04:52:26
  kind: decision
  summary: "Durable discovery policy starts off, uses original owner/role versions and immutable atomic command receipts, and requires explicit enable to resume. Role drift revokes effective activity. Original authenticated API configures only; source signals are internal metadata, monotonic/deduplicated, exclude own generated origins and never resume paused/stopped policy. No scheduler or task/model grant is installed."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T04:54:28
  kind: decision
  summary: Record durable policy API and signal storage without claiming scheduler or task execution.
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T04:57:44
  kind: evidence
  summary: "Final local policy/API/contract suite passes with original atomic recovery, owner checks, two-process CAS and immutable history; complete Gateway1396 cases/1389 pass/7 existing skips, root32 and local builds pass. Public772-file scan has no findings. Synthetic1000-signal allocation grew444KiB; production retention/growth and full execution integration remain open."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T05:06:43
  kind: decision
  summary: "Discovery readiness must observe existing owned task budgets and Coordinator logical slots, never allocate fresh allowance or a second scheduler. Root usage follows exact ledger scope bindings including members; daily overlap alone does not fence other tasks. Unknown/in-flight usage stays unresolved; read snapshots do not reserve writer locks, calls or leases. Original transactional admission and immutable discovery-task binding remain required."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T05:07:16
  kind: decision
  summary: "Record original budget/capacity observation prerequisites and shared-root projection correction; preserve all remaining execution requirements."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T05:09:16
  kind: evidence
  summary: "Original budget/capacity observation and shared-root projection regression verified: Gateway1403 cases/1396 pass/7 existing skips, root32 and local builds pass, public773-file scan0. Shared-root unknown member is visible while daily-only siblings remain independent; original foreground/lease admission semantics retained. No new execution authority, provider run or production enablement."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T05:26:19
  kind: decision
  summary: "Explicit policy enable prepares one immutable original task/budget identity through the original transaction; pause/stop/resume reuse it without resetting counters. Managed trigger has no due time and generic inputs cannot create it. SQL occurrence admission remains closed until verified source/reservation/authority integration; no escape boolean or new planner. Current role validation stays inside the command transaction, preserving narrow configured-task facades."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T05:28:43
  kind: decision
  summary: Record fixed original task preparation and verified built BFF lifecycle while keeping actual occurrence admission closed and full scope open.
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T05:46:52
  kind: decision
  summary: Record trusted metadata ingestion on the original Worker while preserving closed occurrence admission and all remaining acceptance.
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T05:47:11
  kind: decision
  summary: "Source collection uses original typed chat and immutable file metadata only. Task cumulative scope lineage excludes own project discovery outputs; unresolved recorded producers hold later versions, and policy pause or stop never resumes itself. No occurrence grant is enabled."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]

- time: 2026-10-17T05:48:00
  kind: evidence
  summary: "Trusted source ingestion validated on real isolated original SQLite/Workbench/chat/budget/maintenance: focused16, full Gateway1424 cases/1417 pass/7 existing skips/0 fail, root32 and local Windows builds pass. Synthetic derived lineage is not SDK/provider acceptance; no new occurrence/run/model attempt or production enablement. Public779-file preflight0; full lifecycle remains incomplete."
  source: docs/superpowers/plans/2026-10-17-always-on-discovery.md
  affects: [always-on-discovery]
