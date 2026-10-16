---
id: native-goal-boundary
title: Keep native Goal state and continuation in DSH
category: decision
status: active
created: "2026-10-16T11:44:16"
updated: "2026-10-16T12:04:44"
---

<!-- compiled_truth -->
DSH is the authority for Goal state, creation and automatic rounds. Gateway control routes resolve an existing owner-bound ordinary Session and allow only exact-revision pause/resume/stop; role and task Goals use their own scoped paths. These controls do not approve external effects or certify task completion.

Observe native rounds on the existing stream. Paused or blocked Goals must suppress legacy crawl-follow prompts. A stream ending while continuation remains armed is an interrupted outcome, not completion.

Reading a persisted Goal after Host restart uses the official projection API. It must not create an Agent, call a model or restore process-local activation. Persisted phase and live activation are separate facts. Unavailable projection data is not proof that no Goal exists.

Human controls retain their exact CAS command and idempotency key when the response is unknown, including IDEMPOTENCY_IN_PROGRESS. A product run in running status is a necessary resume boundary, not sufficient proof that a native follower is attached. Full cold control and observed run reattachment still require implementation and acceptance. Do not imitate human resume with a model prompt: official tools reject resuming a durable paused Goal.


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
