# Public product research

Research date: 2026-10-01. This document uses public product pages and official repositories only. It does not describe a private deployment. Features below are vendor descriptions, not independently tested findings.

## Primary product references: Dots and Muse

| Reference | Publicly described direction | Jot's planned response |
|---|---|---|
| OpenAI Dots | Personal agents that own responsibilities, continue between conversations, use tools and their own computer, and bring work and decisions to users | Persistent goals, task history, reviewable deliverables, and explicit user control |
| Meta Muse | Personal agent tasks with browser navigation and form interaction; published safety discussion separates the main agent from a browser sub-agent | Authorized browser workflows, outcome verification, clear permissions, and useful handoffs |

Official sources:

- [OpenAI Dots product page](https://chatgpt.com/features/dots/): responsibility-driven work, connected tools, progress review, pausing, and permission rules.
- [Meta Muse introduction](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/): personal-agent positioning.
- [Meta's Muse security and safety discussion](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse): browser sub-agent and boundaries for interacting with untrusted pages.

Dot here means an individual agent within OpenAI Dots, not the unrelated New Computer journaling companion. Product reference does not imply affiliation, copied implementation, model equivalence, or guaranteed feature parity.

## Open-source comparison set

| Project | Official positioning / documented scope | Relevant comparison |
|---|---|---|
| [DeerFlow](https://github.com/bytedance/deer-flow) | Long-horizon agent harness with skills, sandboxes, memory, and sub-agents | Research, artifacts, long tasks, and continuity |
| [OpenClaw](https://github.com/openclaw/openclaw) | Personal assistant with a gateway for sessions, tools, and channels; configurable models and harnesses | Setup, daily task workflows, user control, and ongoing responsibilities |
| [Browser Use](https://github.com/browser-use/browser-use) | Browser agent with library, CLI, and hosted options | Navigation, form filling, verification, browser latency and cost |
| [Khoj](https://github.com/khoj-ai/khoj) | Self-hostable personal AI for internet/document answers, custom agents, and research automation | Retrieval quality, sources, documents, and continuing research |
| [OpenHands](https://github.com/OpenHands/OpenHands) | Agent Canvas for coding agents, backends, and automations | Backend portability, task visibility, and overlapping developer workflows |
| [OpenManus](https://github.com/FoundationAgents/OpenManus) | General-purpose agent project | Common task execution and extension patterns |

These projects are not interchangeable. A browser library is a specialist baseline, not a direct substitute for an entire user-facing workspace. Only compare features on tasks supported by both products; unknowns remain unknown.

## Research backlog

- [ ] Pin repository revisions and versions before testing.
- [ ] Verify setup, licenses, resource requirements, and model/tool configuration.
- [ ] Classify capability evidence: documentation, runnable example, reproduced result.
- [ ] Test shared tasks using both matched-model and recommended-default tracks.
- [ ] Publish limitations and failures alongside successful runs.
- [ ] Recheck official Dots/Muse descriptions as their capabilities change.

Public descriptions establish comparison questions, not measured superiority. No competitor timing or success rate is asserted here.
