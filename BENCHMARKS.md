# Functionality and efficiency evaluation

Status: protocol only. No measured results are published yet.

## Comparison tracks

1. **Matched configuration:** use the same available model, budget, machine, network region, permissions, and task inputs where supported.
2. **Recommended defaults:** use each product's documented preferred setup to evaluate practical experience.

Keep tracks separate. Pin product revisions and record unsupported settings. Do not change a product's architecture to force a comparison or treat missing features as fabricated timing results.

Primary comparisons: research/artifacts against DeerFlow and Khoj; browser tasks against Browser Use; personal-workflow/setup comparisons against OpenClaw. Other products enter only shared task categories. Dots/Muse are experience references; closed services require separately documented comparable access and should not be given invented benchmark scores.

## Initial suite

| Category | Tasks | Verification |
|---|---:|---|
| Multi-source research | 10 | Reference facts, valid citations, structured output |
| Batch reading | 10 | Complete usable text, ordered results, attributable failures |
| Browser actions | 10 | Correct fields, verified navigation, single submission |
| File delivery | 10 | Real downloadable file, correct requested changes, original preserved |
| Control and continuity | 10 | Approval, cancellation, replay, recovery, ongoing task behavior |

Run at least three independent attempts per supported task/product. Separate repeatable fixtures from live external sites. Use synthetic data and test accounts; do not submit real personal information or perform purchases.

## Measurements

- Task success rate and explicit failure/timeout counts.
- End-to-end P50/P95 for successful completion, plus the distribution of all attempts.
- Cost per successful task, including failed attempts and retries.
- Human intervention, retry count, verified pages per second, and peak resources.
- Queue, planning, search, reading, locating, filling, submitting, waiting for result, verifying, file generation, and final-answer timing.

Human approval waiting is reported separately and included in the full user time. Parallel stage durations are not summed into elapsed wall-clock time. Use monotonic clocks locally; correlate cross-service traces without subtracting uncalibrated clocks.

Batch size, configured concurrency, and measured active pages are three separate values. Fifty input URLs do not imply fifty simultaneous browser pages. Publish cold/warm cache and resource conditions.

## Evidence and scoring

Predefine task-specific success criteria. Use verified facts, DOM/state checks, and file content inspections; an agent saying "done" is insufficient. Ground research scoring in checked answers, with human review where necessary.

Publish task inputs, versions, configuration, anonymized raw timings, outcomes, cost calculations, and known limitations. Remove credentials and session data from traces before publication. Do not cherry-pick the fastest run or quietly exclude failures.

Proposed release targets: at least 90% task success in the initial suite; all ownership and approval tests pass; no duplicate side-effect submissions. These are proposed gates, not achieved scores.

Proposed speed-claim gate: at least 20% lower end-to-end P50 in two comparable core categories, without lower success rate; publish P95, costs, sample sizes, and failures. If the gate is not met, report the actual baseline rather than claiming general leadership.
