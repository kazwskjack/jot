# Product and implementation plan

Status: proposed. Scope: standalone public product planning. No private environment is required by this plan.

## Product goal

Build a self-hostable personal agent workspace, benchmarking the functionality and experience of OpenAI Dots and Meta Muse. Prioritize completed work, reliable control, and measurable efficiency.

Choose a coherent product over a collection of tool demos: research, authorized browser actions, files, and ongoing goals should share task identity, permissions, progress, and deliverables.

## Design boundaries

- One planning owner per conversation; tool workers do not become competing planners.
- Public conversation identity remains separate from private runtime session identity.
- Task state comes from real events; model text alone is not proof of completion.
- Artifacts have identity, versions, ownership, and availability checks.
- Approval, cancellation, and recovery preserve effect safety.
- Models, runtime backends, and tools are configurable adapters.
- A standard installation must not depend on a maintainer's private server or credentials.
- An avatar is optional and never blocks core workflows.

## Milestone 0: public scope and contracts

- [ ] Inventory functionality with evidence levels; do not mark proposed functions as shipped.
- [ ] Define conversation/run/operation/artifact contracts and event schemas.
- [ ] Document ownership, permissions, retention, replay, and terminal states.
- [ ] Audit redistribution terms for every dependency and asset before including it.
- [ ] Define a portable installation and explicit model/API cost expectations.

Acceptance: three initial workflows have concrete completion criteria, legal dependencies, and no private infrastructure requirement.

## Milestone 1: working vertical slice

- [ ] Build a minimal workspace, model configuration, and task runner.
- [ ] Complete multi-source research with checked citations and a table artifact.
- [ ] Complete an authorized synthetic browser form with verified field values and a single submission.
- [ ] Revise a document into a new version and provide a working download.
- [ ] Provide installation diagnostics and a clearly labelled no-key replay demo.

Acceptance: independent testers can install and complete the three workflows from the documentation. Replay is never presented as live execution.

## Milestone 2: reliable task control

- [ ] Add projects, multiple conversations, task history, and replay.
- [ ] Verify network interruption and refresh recovery without duplicate answers or effects.
- [ ] Add approval and waiting states with clear resume behavior.
- [ ] Verify cancellation and new instructions while a task is running.
- [ ] Check artifact ownership, version correctness, expiry, and final-task attachment.

Acceptance: lifecycle and ownership tests pass; repeated effect execution and cross-conversation contamination are absent in the test suite.

## Milestone 3: prove and improve efficiency

- [ ] Instrument queue, planning, search, read, locate, fill, submit, verify, artifact, and final-answer stages.
- [ ] Create a reproducible benchmark suite and publish baseline results.
- [ ] Run relevant open-source comparisons under the protocol in BENCHMARKS.md.
- [ ] Optimize redundant calls, valid caching, read-only batching, and bounded concurrency.
- [ ] Compare improvements under unchanged permissions and success criteria.

Acceptance: performance claims are linked to reproducible records; successful speedups do not hide regressions in success, cost, or tail latency.

## Milestone 4: persistent responsibilities

- [ ] Add goal scheduling, pause/resume, and meaningful-change notifications.
- [ ] Add user-controlled memory with inspect/export/delete controls.
- [ ] Add tested connectors and explicit scope grants.
- [ ] Provide voice only after permission, transcription, draft, send, and cancellation work end to end.

Acceptance: persistence survives restarts, notification behavior is predictable, and users can stop work and revoke access.

## Milestone 5: public application release

- [ ] Provide source setup and versioned installable/self-hosted artifacts.
- [ ] Publish English/Chinese documentation, troubleshooting, changelog, and contribution guide.
- [ ] Run clean-environment installation, security checks, and workflow acceptance.
- [ ] Publish complete task demonstrations with visible waiting and approval.
- [ ] Label supported platforms, tested capabilities, known limitations, and costs.

Acceptance: a stranger can run real work, inspect evidence, reproduce a benchmark, and submit an extension without accessing private infrastructure.

## Community milestones: 10,000 stars

| Stage | Product evidence | Community action |
|---|---|---|
| 0–100 | Ten external users complete a real task | Improve setup from feedback; show complete workflows |
| 100–1,000 | Three reliable workflows and a reproducible baseline | Publish results, starter tasks, and contribution opportunities |
| 1,000–3,000 | Repeat use and external contributions | Release connectors, task templates, and meaningful improvements |
| 3,000–10,000 | Community-maintained extensions and sustained adoption | Publish integrations, comparisons, and multilingual guidance |

Numbers above are targets, not current statistics or guaranteed deadlines. Track installation success, completed tasks, repeat usage, and contributor activity alongside stars. Do not buy stars, exchange rewards for stars, or lock features behind starring.

## Next decisions

Decide the runnable runtime, supported model configuration, tool interfaces, and first-platform setup before implementing a broad roadmap. This public repository begins with the plan and research; implementation should be introduced as tested vertical slices.
