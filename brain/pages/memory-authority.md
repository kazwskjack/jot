---
id: memory-authority
title: One memory authority with separate extraction and publication
category: decision
status: active
created: "2026-10-15T21:00:42"
updated: "2026-10-15T21:22:29"
---

<!-- compiled_truth -->
Keep exactly one live memory authority: the scoped, versioned Jot memory ledger. Original DSH retains planning, permissions and model usage accounting.

The extraction plugin is an extraction worker, not an extra memory toolset or prompt provider. It must not run alongside an independent extractor over the same source batch. Its scratch summaries are not automatically verified user facts.

BRAIN.md holds explicitly reviewed, publishable project decisions and evidence. It does not automatically receive user conversations, private memories or credentials, and does not make model requests. Read relevant pages on demand instead of injecting both full plugin summaries and the same ledger records.

Integration is incomplete until owner isolation, source freshness, original budget settlement, restart/cancellation and actual provider acceptance have been demonstrated. The standalone runtime and extended Gateway keep distinct contracts.


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
