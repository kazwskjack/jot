---
id: native-goal-boundary
title: Keep native Goal state and continuation in DSH
category: decision
status: active
created: "2026-10-16T11:44:16"
updated: "2026-10-16T13:08:08"
---

<!-- compiled_truth -->
DSH is the authority for Goal state, creation and automatic rounds. Gateway control routes resolve an existing owner-bound ordinary Session and allow only exact-revision pause/resume/stop; role and task Goals use their own scoped paths. These controls do not approve external effects or certify task completion.

Observe native rounds on the existing stream. Paused or blocked Goals must suppress legacy crawl-follow prompts. A stream ending while continuation remains armed is an interrupted outcome, not completion. Native view enums are exact strings; coercible malformed values cannot become a completion fact.

Reading a persisted Goal after Host restart uses the official projection API. It must not create an Agent, call a model or restore process-local activation. Persisted phase and live activation are separate facts. Unavailable projection data is not proof that no Goal exists.

Explicit cold pause/clear can resolve an ordinary Agent only after checking the stored preset, empty inbox and closed contiguous history through official inspect. The operation rechecks live identity and inbox, uses native maintenance and flushes persistence. Stop is one native clear tombstone. Pending input is a definite recovery refusal before activation; Host-only turnBoundary is not a public wire projection.

Human controls retain their exact CAS command and idempotency key when the response is unknown. Resume is an explicit human execution intent in the original database/run/Worker lineage, not another Goal authority or a model input. Original input text, images and attachments must not be replayed. A dispatch belongs to one live follower cursor and one Worker lease generation; an unconfirmed mutation cannot be replaced with a new request. Accepted intent, applied native receipt and completed Goal are separate facts.

The durable control journal and Worker continuation entry are implemented internally. Full cold resume still requires the Host observer/maintenance/receipt handshake, supported history recovery, public atomic admission and real SDK acceptance. No public resume readiness is inferred from a fake runner or product running status. Mixed-version runners refuse the new path instead of falling through to ordinary prompts. Official model tools reject resuming a durable paused Goal; do not use a model prompt to imitate human resume.


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
