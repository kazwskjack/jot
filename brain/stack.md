---
slug: stack
title: Tech stack
role: tech-stack choices
updated: "2026-10-15T21:02:39"
---

# Tech stack

## Technology choices
Node.js and TypeScript provide the runtime and integration layer. React provides the workbench. SQLite holds durable scoped task and memory state. Original DSH sessions remain responsible for Agent execution.

## Memory tooling
The reviewed memory publication format is BRAIN.md, using @mindmux/brain-md 0.3.0 as a local development dependency. The proposed extraction integration uses haitang1/dsh-memory 0.5.0 at a pinned reviewed revision in an isolated DSH environment. No global brain skill installer or lifecycle shell hook is required for Windows.
