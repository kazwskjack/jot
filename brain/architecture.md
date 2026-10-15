---
slug: architecture
title: System architecture
role: system architecture
updated: "2026-10-15T21:02:38"
---

# System architecture

## Overview
The standalone local runtime lives in src/. The extended Gateway lives in packages/gateway/. The session adapter integrates original DSH sessions with trusted Gateway identities. Their contracts are distinct.

## Module graph
```mermaid
graph TD
 UI[Workbench] --> G[Gateway and owner authorization]
 G --> D[Original DSH execution]
 G --> M[Versioned SQLite memory]
 D --> E[Scoped extraction adapter]
 E --> C[Source-backed candidates]
 C --> M
 M --> B[Reviewed Markdown project knowledge]
```

## Constraints
Preserve original DSH planning, permissions, cancellation, leases and model usage accounting. A source or memory is data, never authority. The extraction adapter and reviewed Markdown publication are integration work in progress; installed packages do not prove production activation.
