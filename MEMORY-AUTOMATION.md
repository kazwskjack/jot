# Memory capture and project knowledge

Jot keeps one scoped, versioned live memory ledger. The original DSH runtime remains responsible for planning, permissions, cancellation and model usage accounting.

## What is connected

The workbench's **Automatic memory** entry lets the owner enable future-run public-message capture for a role. It is off by default. Assistant text and generated automation inputs are separate opt-ins. Hidden reasoning, tools, images and attachments are excluded.

Completed successful or partial runs produce source batches with message/block references, content hashes and explicit truncation counts. Failed or missing runs do not become text sources. Collection alone makes no model request. Reading a management page never captures a new source.

The original `jot_workspace` tool exposes `memory.capture.pending`, `memory.capture.read` and `memory.capture.propose`. A model can propose source-backed notes but cannot change the owner policy or approve application. No candidate changes live memory until the owner confirms it in the workbench. New notes are private to that role and unverified. Existing exact-content notes can be reused without changing their verification state.

Apply/reject and policy writes use version checks and atomic idempotency receipts. A lost response is retried with the original request. Source changes hide unavailable bodies and candidates; cached native reads must revalidate sources. Each role/policy has at most 50 ready/proposed batches. Further watches wait without interrupting ordinary chat.

## Extraction-plugin integration boundary

The extraction engine is [haitang1/dsh-memory](https://github.com/haitang1/dsh-memory), version 0.5.0 at revision `15de1c791bbcb5be2c9b0c2096eddedcaa61cc17` (MIT). The optional loader verifies its package and JavaScript hashes and the tested Cordis 4.0.4 / DSH LLM 0.2.0-rc.2 versions before enabling extraction. A missing or changed optional plugin reports not ready without taking ordinary Sessions offline.

Each source batch has one immutable `memory_capture` processing identity and an internal original DSH run. The run inherits the source's cumulative budget scopes and today's ordinary daily scopes; it cannot obtain fresh cumulative spending by changing conversations. Its internal conversation is excluded from chat lists and project counts. It has no recalled memories or external tools and can only read its bound batch and propose candidates.

The original worker pool tries ordinary work first, then its extraction pump. Original background capacity, role idleness, owner/project/role, policy/epoch, source freshness and source-task pause checks remain enforced. The plugin uses the original budgeted LLM stream at high reasoning, a single model call, a separate scratch directory and no duplicate tools, runtime skill or full-summary prompt injection. It cannot approve memory. The Host polls authority and propagates cancellation to the auxiliary stream; incurred costs can still settle after authority is revoked.

A lost Host response can complete from the exact committed proposal and settled original usage. In-flight/unknown usage and an existing scratch claim never cause a speculative new provider call. Unresolved runs stop for reconciliation; they do not silently retry with a new run. The Gateway also enforces one dispatched extraction call per processing run across Host and lease changes, using the original budget ledger. Only reservations proven never dispatched can be released and replaced; a settled call without a proposal still requires reconciliation. The workbench shows processing or reconciliation status. Exhaustive crash recovery and actual provider quality still require deployment-specific acceptance.

### Optional host configuration

Install the pinned plugin in the existing isolated DSH profile, not globally, and preserve the upstream license. In the session adapter's trusted configuration set `memoryExtraction` with exactly:

| Key | Value |
|---|---|
| `modulesRoot` | Absolute path to that profile's `node_modules`, containing the reviewed plugin and SDK |
| `root` | Absolute private scratch directory dedicated to extraction; never a public or Git directory |
| `maxOutputTokens` | The existing priced model route's output ceiling; mirror it rather than introducing a separate budget policy |

Keep the existing `workbenchModel`, original model-budget configuration and budgeted preset. Set `GENERAL_AGENT_MEMORY_EXTRACTION_ENABLED=true` on the existing Gateway worker, with execution readiness and at least two original pool slots so the configured background allowance is nonzero. This adds no extra worker pool. Enabling the original worker does not resume paused persistent tasks: stale queued occurrence projections remain subordinate to the task generation and original run state. The authenticated `/v1/memory-extraction/readiness` endpoint reports readiness without starting a model. Enable the role's **Automatic memory** policy in the workbench; it covers future bindings only. Assistant and automation sources remain separate opt-ins.

The package includes the optional loader, original-pool pump and Host entry. Local tests include the actual SDK/plugin with a scripted model, cancellation, source revocation, accounting and lost-response checks. These are not evidence that a particular production installation is configured, or that a real provider extracts useful notes. Confirm its readiness, one future source batch, exact candidate provenance, original usage and owner approval separately before claiming production acceptance.

## BRAIN.md

[BRAIN.md](BRAIN.md) and `brain/` are the reviewed project-knowledge format, powered by the pinned local `@mindmux/brain-md` 0.3.0 development dependency (Apache-2.0). Use `npm run brain -- list-pages`, `read-page <id>` or `lint-links`. No global skill setup or shell lifecycle hook is needed for the supported Windows CLI workflow.

BRAIN makes no model requests and is not a second conversation extractor. This repository's pages contain publishable architectural knowledge only. Never export actual conversations, private user memories, keys, profiles or runtime endpoints into a public brain. An Agent reads relevant pages on demand, rather than injecting both a full plugin summary and the same ledger records.

## Storage behavior

Summary-size settings do not bound all disk use. Extractor rollout files, journals and archives can accumulate; BRAIN timelines and Git history also grow. Retention must preserve evidence still referenced by candidates or rollback history.

A local synthetic measurement of 100 different 512-byte notes added about 1.25 KB per extractor turn when writing both raw entries and rollouts. Updating the same BRAIN page added about 140 bytes per revision. These are logical file bytes, not production daily rates or filesystem allocation. They exclude SQLite/WAL, source conversations, images, backups and Git history. The integration does not automatically publish each extracted note into BRAIN or enable duplicate raw-writing tools.

Measure actual growth using successive timestamped samples of the same runtime storage scope. Report the sampling interval, net bytes and a separate breakdown for database/WAL, attachments, logs and backups. Do not treat archive rotation as total-size enforcement or extrapolated fixture data as a production benchmark.
