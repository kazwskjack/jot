# Memory capture and project knowledge

Jot keeps one scoped, versioned live memory ledger. The original DSH runtime remains responsible for planning, permissions, cancellation and model usage accounting.

## What is connected

The workbench's **Automatic memory** entry lets the owner enable future-run public-message capture for a role. It is off by default. Assistant text and generated automation inputs are separate opt-ins. Hidden reasoning, tools, images and attachments are excluded.

Completed successful or partial runs produce source batches with message/block references, content hashes and explicit truncation counts. Failed or missing runs do not become text sources. Collection alone makes no model request. Reading a management page never captures a new source.

The original `jot_workspace` tool exposes `memory.capture.pending`, `memory.capture.read` and `memory.capture.propose`. A model can propose source-backed notes but cannot change the owner policy or approve application. No candidate changes live memory until the owner confirms it in the workbench. New notes are private to that role and unverified. Existing exact-content notes can be reused without changing their verification state.

Apply/reject and policy writes use version checks and atomic idempotency receipts. A lost response is retried with the original request. Source changes hide unavailable bodies and candidates; cached native reads must revalidate sources. Each role/policy has at most 50 ready/proposed batches. Further watches wait without interrupting ordinary chat.

## Extraction-plugin integration boundary

The evaluated extraction engine is [haitang1/dsh-memory](https://github.com/haitang1/dsh-memory), version 0.5.0 at revision `15de1c791bbcb5be2c9b0c2096eddedcaa61cc17` (MIT). Its isolated import, upstream synthetic tests and real Cordis initialization have been checked locally. It is **not yet wired as a production automatic worker**.

Its default global store, direct background model calls, reasoning-off requests, memory tools, runtime skill and prompt injection must not be mounted unchanged into Jot. The remaining integration must use a trusted processing run, original model admission/usage accounting, role-specific storage, source validation and the same candidate-review flow. There must be only one extractor per source batch and one memory injection path. Existing manual capture tools are not evidence of unattended extraction.

Idle dispatch, restart/cancellation recovery, actual provider quality and production acceptance remain open. Installation and scripted model tests do not prove those requirements.

## BRAIN.md

[BRAIN.md](BRAIN.md) and `brain/` are the reviewed project-knowledge format, powered by the pinned local `@mindmux/brain-md` 0.3.0 development dependency (Apache-2.0). Use `npm run brain -- list-pages`, `read-page <id>` or `lint-links`. No global skill setup or shell lifecycle hook is needed for the supported Windows CLI workflow.

BRAIN makes no model requests and is not a second conversation extractor. This repository's pages contain publishable architectural knowledge only. Never export actual conversations, private user memories, keys, profiles or runtime endpoints into a public brain. An Agent reads relevant pages on demand, rather than injecting both a full plugin summary and the same ledger records.

## Storage behavior

Summary-size settings do not bound all disk use. Extractor rollout files, journals and archives can accumulate; BRAIN timelines and Git history also grow. Retention must preserve evidence still referenced by candidates or rollback history.

A local synthetic measurement of 100 different 512-byte notes added about 1.25 KB per extractor turn when writing both raw entries and rollouts. Updating the same BRAIN page added about 140 bytes per revision. These are logical file bytes, not production daily rates or filesystem allocation. They exclude SQLite/WAL, source conversations, images, backups and Git history. The integration will not automatically publish each extracted note into BRAIN or enable duplicate raw-writing tools.

Measure actual growth using successive timestamped samples of the same runtime storage scope. Report the sampling interval, net bytes and a separate breakdown for database/WAL, attachments, logs and backups. Do not treat archive rotation as total-size enforcement or extrapolated fixture data as a production benchmark.
