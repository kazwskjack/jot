# Jot

**An open agent workspace, designed to turn a goal into verified work.**

[中文](README.zh-CN.md) · [Product plan](PLAN.md) · [Research](RESEARCH.md) · [Benchmarks](BENCHMARKS.md) · [Contributing](CONTRIBUTING.md)

> **Status: planning and public research.** This repository currently contains product design, a roadmap, and an evaluation protocol. It does not yet ship an installable agent application. All functionality below is a target until supported by a release and reproducible evidence.

## Product direction

Jot benchmarks its product direction against **OpenAI Dots (a personal dot)** and **Meta Muse**: persistent responsibilities, useful tools, human control, and results that people can review. Jot is an independent project, with no affiliation or endorsement. It does not claim feature parity or superior speed.

The focus is functionality and efficiency, rather than an avatar:

- **Research to deliverable:** search multiple sources, read pages, extract structured facts, and deliver a sourced report or table.
- **Authorized browser work:** navigate, filter, fill, and submit, verify the outcome, and ask for help when access or approval is required.
- **File work:** read and revise documents, preserve originals, and deliver actual downloadable versions.
- **Persistent responsibilities:** follow changes, resume work, and notify the user when there is something meaningful to review.
- **Visible control:** see progress, approve actions, change direction, cancel, and recover without repeating side effects.

## What should make Jot useful?

1. Complete workflows, from the user's request to a verifiable result.
2. Measurable time and cost, including failures, retries, and waiting.
3. Self-hosting and configurable models, without a mandatory proprietary deployment.
4. Clear permission boundaries and traceable task outcomes.

These are design commitments, not benchmark results. We will publish comparisons before making performance claims.

## Initial workflows

| Workflow | Example | Completion evidence |
|---|---|---|
| Research | Compare options from multiple public sources | Checked facts, accessible citations, downloadable table |
| Browser action | Fill a synthetic form and inspect the result | Verified field values and exactly one authorized submission |
| Document revision | Update specified sections without overwriting the original | A new file version with the requested changes |
| Ongoing task | Watch a public source for meaningful changes | Persistent configuration, change evidence, user-controlled notifications |

## Roadmap

- [ ] Define the public contracts and portable runtime boundaries.
- [ ] Deliver a self-hosted vertical slice for research, browser work, and file delivery.
- [ ] Make approval, cancellation, replay, and recovery reliable.
- [ ] Publish reproducible functionality, latency, and cost comparisons.
- [ ] Add persistent tasks, user-controlled memory, and tested connectors.

See [PLAN.md](PLAN.md) for milestones and acceptance criteria.

## Efficiency

We measure end-to-end completion time, success rate, cost per successful task, and human intervention. First-token latency or configured concurrency alone is not a productivity result.

No measured performance comparison has been published in this repository yet. See [BENCHMARKS.md](BENCHMARKS.md) for the protocol.

## Community goal

The long-term community goal is **10,000 GitHub stars**, supported by useful software, reproducible evidence, and external contributions. It is an aspiration, not a delivery date or guaranteed outcome. Stars do not unlock functionality.

## License

Original materials in this repository are provided under the [MIT License](LICENSE). External products, names, code, models, and assets retain their own terms. No external implementation or proprietary product assets are bundled here.
