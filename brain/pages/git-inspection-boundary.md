---
id: git-inspection-boundary
title: Git views use owned read-only repository snapshots
category: decision
status: active
created: "2026-10-19T17:04:32"
updated: "2026-10-19T17:05:12"
---

<!-- compiled_truth -->
Git workbench reads are bound by operator configuration to an existing owner and project. Browser input may choose an owned project and a file from a reviewed snapshot, never a root, executable or arbitrary command. Recheck project ownership and physical repository identity after awaited reads. A snapshot or diff grants no execution, commit, discard, push or native Goal authority.

Read Git through a disposable controlled metadata copy containing the exact original HEAD, index and refs and a fixed verified object directory. Copy only allowlisted nonexecutable repository configuration. Do not activate source include files, hooks, clean/process filters, fsmonitor, external diff/textconv, lazy fetch or interactive credentials. Disabling external diff alone did not prevent clean-filter handling. The copy is private temporary read machinery, not a replacement repository, mutation target, planner or receipt store; source metadata and working-file witnesses must still match before results are published.

Keep bounded output/cancellation and credential-free remote projections. Future local and remote mutations must target the original trusted repository under separate reviewed intents and immutable recovery receipts. Read-only acceptance does not complete the full Git capability or the PilotDeck ledger.


## Timeline

- time: 2026-10-19T17:04:32
  kind: decision
  summary: "Created this page: Git views use owned read-only repository snapshots"
  source: docs/superpowers/plans/2026-10-19-git-workbench.md
  affects: [git-inspection-boundary]

- time: 2026-10-19T17:05:12
  kind: decision
  summary: Bind Git inspection to original project ownership and isolated nonexecuting metadata reads
  source: docs/superpowers/plans/2026-10-19-git-workbench.md
  affects: [git-inspection-boundary]
