---
id: memory-authority
title: One memory authority with separate extraction and publication
category: decision
status: active
created: "2026-10-15T21:00:42"
updated: "2026-10-15T22:38:42"
---

<!-- compiled_truth -->
The original DSH runtime owns planning, permissions, cancellation and model accounting. Jot's scoped, versioned ledger is the only live-memory authority.

The pinned dsh-memory engine extracts source-backed candidates through a dedicated original processing run and the original pool's idle fallback. It has no second memory toolset, planning loop, live-memory writer or full-summary prompt provider. Source cumulative budget scopes are preserved. Current role/policy/source guards and original leases govern every effect; interrupted unknown usage is not silently repeated. Candidates need owner approval and remain unverified on first application.

BRAIN.md holds reviewed, publishable project knowledge. It receives no automatic private conversation export and makes no model calls. Read relevant pages on demand.

Optional loader, Host entry and idle pool dispatch have passed local actual-SDK/plugin tests with a scripted model, including revoked-source accounting. This does not establish production readiness or real-provider extraction quality. Those require deployment-specific acceptance; complete crash recovery remains separate. See MEMORY-AUTOMATION.md for configuration and limits.


## Timeline

- time: 2026-10-15T21:00:42
  kind: decision
  summary: "Created this page: One memory authority with separate extraction and publication"
  source: docs/WORKBENCH.md
  affects: [memory-authority]

- time: 2026-10-15T21:02:39
  kind: decision
  summary: "Separate extraction, live memory authority and reviewed project publication"
  source: docs/WORKBENCH.md
  affects: [memory-authority]

- time: 2026-10-15T21:22:29
  kind: decision
  summary: "Correct source reference: earlier docs/WORKBENCH.md meant root WORKBENCH.md; add current integration evidence"
  source: MEMORY-AUTOMATION.md
  affects: [memory-authority]

- time: 2026-10-15T21:35:01
  kind: evidence
  summary: "Scoped capture, owner review and original DSH budgeted proposal wiring passed local regression and isolated browser checks; idle plugin dispatch remains open"
  source: MEMORY-AUTOMATION.md
  affects: [memory-authority]

- time: 2026-10-15T22:38:42
  kind: decision
  summary: "Record optional pinned extraction, original idle pool and accounting evidence without claiming production acceptance"
  source: MEMORY-AUTOMATION.md
  affects: [memory-authority]
