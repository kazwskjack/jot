# PilotDeck capability and implementation reference

Jot's reference scope covers all PilotDeck functions and implementation mechanisms, not only its interface or headline features. This checklist is not a claim of complete parity.

Reference: [OpenBMB/PilotDeck](https://github.com/OpenBMB/PilotDeck), commit `783499ffdb2d501bf590b2e035acd027a882df10`, licensed AGPL-3.0. These are design references. Copying or adapting upstream code requires preserving attribution and satisfying applicable license obligations; reused implementations must not be described as independently authored.

DSH retains planning, conversation lifecycle and native Goal execution. Gateway retains ownership, permissions, leases, occurrences, memory revisions and delivery acceptance. Jev/Laya decisions remain subject to these boundaries. Upstream capabilities map to existing contracts without silently creating a second planner or competing authoritative store.

| Capability | Upstream entry | Required integration and acceptance |
|---|---|---|
| Workspaces/projects | `src/pilot`, `src/session/filesystem`, `ui/server/routes/projects.js` | Creation/deletion, nested files, uploads/downloads, concurrent edits, owner/path boundaries. |
| Conversations/execution | `src/agent`, `src/task`, `src/session`, `src/gateway`, `src/lifecycle` | Streaming, steering, cancellation, restart recovery, forks, final-answer reconciliation through DSH. |
| Roles/delegation | `src/agent/sub`, `src/session/transcript` | Role lifecycle, scoped memory, messages, frozen assignments, reviewed results, parent delivery. Subagent support alone does not prove full teams. |
| White-box memory | `src/context/memory`, `ui/server/routes/memory.js` | Extraction/retrieval traces, provenance, edit/delete, expiry, import/export, version history. |
| Dream consolidation | `src/context/memory/edgeclaw-memory-core/src/service.ts` | Staging, proposals, snapshots, concurrent-write conflicts, installation and rollback without reviving tombstones. Individual revision restoration is not Dream parity. |
| Context/token use | `src/context/budget`, `compaction`, `cache`, `projection`, `src/model/usage` | Visible compaction, image-result archival, short checkpoints, actual usage/cache accounting. |
| Models/routing | `src/model`, `src/router` | Modality/context compatibility, health, judge overhead, fallback, accounting for every attempt; preserve reasoning settings. |
| Always-on | `src/always-on` | Discovery, work cycles, busy/cooldown gates, authorized execution, reports, reviewed application through native Goal. |
| Scheduling | `src/cron`, `ui/server/routes/cron-jobs.js` | Time zones, missed triggers, restart deduplication, occurrences, leases, pause/resume/stop. |
| Task management/PRDs | `ui/server/routes/taskmaster.js` | Installation readiness, lists, next task, PRD parsing/templates, updates mapped to existing task IDs. |
| Tools/concurrency | `src/tool/registry`, `execution`, `scheduler` | Schemas, permissions, dependency order, safe concurrency, cancellation, receipts, unknown write outcomes. |
| Browser | `src/tool/builtin/web`, `ui/server/utils/globalChrome.js` | Initialization coalescing, health, profile persistence, screenshots, control discovery; preserve ownership and deliberate close. |
| Computer Use/desktop | `ui/server/routes/computer-use.js`, `scripts/computer-use`, `apps/desktop` | Driver protocol, OS permissions, coordinate mapping, disconnect recovery; distinguish browser from desktop. |
| Checkpoints/artifacts | `src/session/checkpoints`, `worktree`, `artifacts`, `ui/server/routes/checkpoints.js` | File snapshots, previews, conflicts, restore, forks, attachments. File restore cannot undo external actions or restore old authority. |
| Git workbench | `ui/server/routes/git.js`, `user.js` | Status/diff, branches, commits/revert, remote status, fetch/pull/push/publish, discard, untracked deletion; writes remain authorized. |
| Commands/skills | `ui/server/routes/commands.js`, `skills.js` | Discovery, load, execution, document addressing, installation, scoped configuration. Loading is not execution authority. |
| MCP/plugins/hooks | `src/mcp`, `src/extension`, `ui/server/routes/mcp.js`, `plugins.js` | Discovery, lifecycle, installation/update/removal, permissions, tool results, configuration reload. |
| Voice | `src/extension/plugins/builtin/funasr`, `docs/funasr-installation.md` | ASR setup, input/cancel/draft handling; TTS requires separate verification. |
| Channels | `src/adapters/channel` | Inspect Web/CLI/TUI/API and each IM/email adapter: identity, threads, attachments, receive/send, receipts, recovery. |
| Notifications/push | `ui/server/routes/settings.js` | Preferences, subscriptions, owner binding, receipts; unknown delivery cannot be blindly replayed. |
| Web/editors | `ui/src`, `ui/server` | Timeline, files, Office/code preview, model controls, responsive input, themes, accessibility, lazy-loaded large bundles. |
| Credentials/auth/network | `src/permission`, `src/network`, `ui/server/routes/auth.js`, `settings.js` | Credential references, API keys, login, request/path boundaries, network rules, redaction; local no-auth defaults are not public defaults. |
| Onboarding/settings | `ui/server/routes/onboarding.js`, `models.js`, `config.js`, `user.js` | Provider tests, image-capability verification, workspace setup, runtime health/retry, schema migration. |
| Desktop packaging | `apps/desktop` | Electron packaging, windows, OS integration, updates and permissions; distinct from a hosted desktop. |
| Install/update | `install.ps1`, `install.sh`, `README_SOURCE_INSTALL.zh.md`, `docker-compose.yml`, `ui/server/routes/update.js`, `webUpdate.js` | Windows/Linux/Docker, migrations, version checks, failed updates and rollback. |
| Observability/testing | `src/telemetry`, `src/status`, `tests`, `ui/e2e`, `ui/server/routes/usage.js` | Runtime health, task usage, privacy controls; separate unit/integration/browser and real-provider evidence. |

Discovering additional source modules or routes extends this checklist. For each row record source symbols/call chain, storage/events, Jot gaps, integration points, defaults, failure recovery, tests and license provenance.

## Delivery order and evidence

1. Identity, events, permissions, versioning and execution contracts.
2. Workspaces, traceable memory and consolidation/recovery.
3. Tasks, Always-on, schedules and routing.
4. Interface, Git, tools/plugins, voice, channels and desktop.
5. Upgrade/restart recovery, cross-platform behavior, performance and cross-owner denial tests.

Track **inventoried**, **source reviewed**, **implemented**, **locally tested**, **real-provider tested**, and **deployment accepted** separately. A successful build or HTTP 200 is not workflow acceptance. Upstream marketing performance figures are not Jot benchmarks.

The reference core/UI have been built in an isolated Windows environment, and its Web server passed a no-credential startup smoke test. Core tests still contain failures and cancellations, including Windows path/symlink and timer behavior requiring investigation. This is not production acceptance or complete integration.

## Current consolidation milestone

Reviewed staging/proposal, immutable source trace, owner-confirmed atomic rewrite/duplicate merge, conflict checks and version-safe rollback are connected through the original DSH workspace tool and the workbench UI. They reuse the existing model budget and permissions. This does not complete automated message extraction, retrieval traces or idle-triggered consolidation. Real SDK tests use a scripted local provider; real-provider consolidation quality and production acceptance remain unverified.

## Current retrieval trace milestone

The original scope/keyword/adapter ordering now has owner-readable query and context-snapshot evidence, immutable version references, selection statistics, cursor paging and live source revalidation. Corrected/deleted/expired versions do not expose old bodies through trace reads. This does not replace PilotDeck's reasoning retriever with an equivalent semantic pipeline; automatic capture and idle execution remain incomplete. SDK input checks and actual BFF/UI/Gateway tests are separate evidence from real-provider quality.

## Current capture milestone

Future-run source policies, completed public-message capture, immutable source references, native pending/read/propose tools and owner-reviewed application are connected to the workbench. Actual BFF/UI/Gateway tests cover policy save, explicit review, response-loss retry, source invalidation and role isolation. See [memory automation](../MEMORY-AUTOMATION.md) for the remaining extraction-worker boundary. Idle model dispatch and production automatic extraction are not yet accepted; BRAIN.md is a reviewed project-knowledge format, not another model or memory authority.


### Optional source extraction

The reviewed dsh-memory engine now has an isolated Host entry and original-pool idle dispatch. Dedicated immutable processing lineage inherits the source cumulative budget; exact original leases, public-source hashes, policy/epoch and source-task state remain authoritative. No duplicate memory tools, planner or full-summary injection is enabled. Local actual-SDK/scripted-model probes cover dispatch, revoked-source accounting and candidates awaiting owner review. Lost Host replies reconcile committed proposals; unknown usage and unconfirmed claims stop rather than repeat.

This adds locally verified extraction wiring, not automatic Dream consolidation, exhaustive crash recovery, real-provider quality or production acceptance. BRAIN.md remains a separate reviewed publication format; it does not become a second user-memory store. The complete upstream capability inventory remains in scope.

## Native conversation Goal boundary

Ordinary Goal observation and exact-revision controls use the original DSH
Session. Role/task Goals stay scoped. Cold reads do not create an Agent or
rearm a persisted Goal. Cold pause/clear use the official resolver, maintenance
and persistence after checking the ordinary preset, empty inbox and closed
history. Actual Host probes cover persistence and competing CAS without inference.

The ordinary composer has **+ → Goal mode** and a native status card. Explicit
resume uses an atomic public 202 acceptance, a message-free original product run,
Coordinator lease and distinct native Runner entry. Follow attaches before Agent
restoration; native persistence and the exact control receipt precede model calls.
The UI tracks acceptance, queued execution and native completion separately.
Unknown responses retry the exact request. An old observer cannot execute a
replacement Goal in the same Session.

Real locked-SDK tests enter both direct observation and public admission through
the original Worker, use a scripted local model, publish one assistant answer,
retain only the original human message, and preserve completion after Host restart.
The source-input join cannot replay a null-input continuation. This does not prove
that historical queue consumers can execute it, real-provider quality, comprehensive
crash recovery or production accounting. Full consumer-pool rollout, supported
pending/interrupted-history recovery and deployed acceptance remain required.
The two explicit rollout switches default off. See [Goal continuation](GOAL-CONTINUATION.md).

These changes do not complete the remaining Always-on, UI, routing, channel and
packaging rows above; the complete 26-capability scope remains unchanged.
