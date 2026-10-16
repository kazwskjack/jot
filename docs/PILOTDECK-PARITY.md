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


The observed Goal adapter parks official follow at its opening snapshot until
preflight and native maintenance admit restoration. This matters because the
locked official iterator promotes a prepared Session when advanced past that
snapshot. Confirmed pre-native refusals have exact immutable receipts; failures
after invoking native resume remain uncertain. See [Goal failure and crash
boundaries](GOAL-CONTINUATION.md#failure-evidence-and-remaining-crash-matrix).


Ordinary Goal controls now persist minimal owner/conversation-scoped command
metadata before POST, recover the original key after reload or renderer-process
termination, and require explicit retry. Separate command keys preserve uncertain
operations from different tabs; acknowledged tombstones prevent pruning failures
from resurrecting them. Account changes and unavailable browser storage fail
closed. No objective, message or credential is journaled. This is local recovery
evidence; OS/power-loss and production acceptance remain unverified. See
[browser command recovery](GOAL-CONTINUATION.md#browser-command-recovery).


The locked SDK's cold query already presents conservative logical closers for
persisted interrupted tails; its original resolver commits them during resume.
Jot keeps that implementation. Real Host regressions now cover an open tail and
started/unstarted tool requests, read-only log hashes, original-run continuation
and cold restart. Pending/claimed input and still-open attached turns remain
separate unresolved recovery requirements. See [official interrupted-tail recovery](GOAL-CONTINUATION.md#official-interrupted-tail-recovery).


Revoking an ordinary Goal observer now cancels its same-Goal in-flight work with
the SDK's `keepInbox` option, preserving later queued and steering inputs.
Paused/blocked/complete phases do not hide a still-running closing request;
replacement Goals remain untouched. A real Host disconnect/flush/restart probe
checks retained input IDs and no extra inference. This does not complete original
pending-input delivery recovery. See [observer revocation](GOAL-CONTINUATION.md#observer-revocation-preserves-other-inputs).


Whole-browser termination exposed a limitation of the former localStorage
journal: same-page read-back did not ensure the command survived process exit.
Ordinary Goal controls now await strict IndexedDB transaction completion before
POST and acknowledgement. The owned-browser process-tree/restart probe passes
with the same profile and exact original request, alongside renderer recovery,
legacy migration and storage-failure tests. OS/power loss and production acceptance
remain unverified. See [browser recovery](GOAL-CONTINUATION.md#browser-command-recovery).


Observer revocation also preserves original human inputs already claimed by the
current live pre-step, before any conversation-message commit. It quietly retains
that unentered step context using the official next-step convention, preserving
IDs/content/source without a new prompt or wake. User cancellation is respected;
conflicting or already committed input is not overwritten/replayed. The real Host
lease-revocation/flush/restart probe makes zero model requests. Cold reconstruction
and original-run execution recovery remain separate. See [live claimed inputs](GOAL-CONTINUATION.md#live-claimed-input-preservation).


## Native Goal pre-flush process boundary

An installed-SDK regression now terminates its isolated Host at the native
resume notification before the adapter flush. A cold unchanged Goal revision
still leaves the original Gateway dispatch uncertain; it cannot certify that
native resume was not invoked. The test verifies zero inference/publication,
original acceptance recovery and refusal of replacement dispatch. This is the
third specific process-death boundary, not exhaustive storage/usage/publication
recovery or deployed acceptance. See [Goal continuation](GOAL-CONTINUATION.md).


## Original ordinary-run recovery and publication

An opt-in reclaimed-run path now uses the original stored Session, observed
native input and Coordinator lease without re-sending the prompt or attachments.
The real installed-Controller/local-model case retains one original run and human
input, one model request and one canonical answer. Source bytes and lease changes
fence publication. Native usage stays in the original Session; monetary/unknown
settlement is not thereby proven. Recovery remains off by default pending explicit
Goal rearming after input recovery, claimed/steering, production composition and
rollout gates. Cold active/complete Goal coexistence is verified without implicit
rearming; paused/blocked Goals refuse before Agent creation or inference.
See [Goal continuation](GOAL-CONTINUATION.md).


## Ordinary claimed-input policy milestone

An unpublished native-factory policy now verifies the original Gateway owner,
run, input hash and lease, plus historical per-message admission and composition
fingerprints, before restoring an unentered claimed human message. Real process
termination/recovery verifies durable original-input restoration once and rejects
wrong lease/profile/admission without model calls. This does not enable ordinary
HTTP claimed recovery: original Controller admission storage, factory composition,
Host/Worker integration and production acceptance remain open. See
[Goal continuation](GOAL-CONTINUATION.md).


## Original prompt admission milestone

An optional Host now records hash-only private receipts from the actual
Controller's final native input and gates model entry on durable admission.
First-generation opted-in Worker/Runner/Client metadata carries only the original
run and lease. Real Controller probes verify claim-gap deduplication, one normal
model execution and one canonical Worker answer, without duplicate execution on
retry/restart. The original attachment pipeline is preserved; these native cases
use text. Cold claimed-factory integration, richer attachment acceptance, cost
settlement, retention and rollout remain separate unfinished gates. See
[Goal continuation](GOAL-CONTINUATION.md).


## Ordinary entry reservation milestone

Versioned original admission receipts now require an exclusive durable native
step-entry reservation. A competing or previously reserved attempt cannot be
replayed from an apparently unentered cold log. Original pending-input recovery
must adopt the real admission gate before wake; legacy identity-only Host
configuration is refused. The entry record is neither a model-call receipt nor
usage/accounting evidence. A real Host hard-exit probe preserves that conservative
boundary. Cold claimed-factory integration and unknown outcome/cost reconciliation
remain open; no production switch is enabled. See
[Goal continuation](GOAL-CONTINUATION.md).


## Observed ordinary claimed-factory milestone

An optional operator-configured original Controller factory now restores
protocol-2 admitted, unreserved ordinary input through reviewed before/after
setup hooks, then passes it to the existing observed Host and original Worker.
The paired real local SDK cases verify one canonical result after hard Host
death and refusal of a previously reserved entry. No prompt replay or implicit
Goal activation is introduced. Earlier policy/reservation-only milestones above
record prerequisites; their cold-wiring gap is now closed locally. Production
composition/attachment acceptance, steering, unknown cost reconciliation and
rollout remain open and defaults remain disabled. See
[Goal continuation](GOAL-CONTINUATION.md).


## Original attachment integrity milestone

Cold claimed-factory publication and pending-input adoption now verify original
image/file bytes through the native attachment store before continuation.
Text-only input does not read binaries; this adds no vision call or upload.
Local real-SDK cases cover retained original file/image references, no file
restaging, and refusal of missing files, missing images or corrupted files.
Real-provider visual quality, additional document formats, monetary settlement
and production rollout remain unverified and disabled. See
[Goal continuation](GOAL-CONTINUATION.md).

## Live ordinary steering checkpoint

A separate opt-in command admission now keeps the original Worker lease and
command RPC, with protocol-3 per-message content/parent proofs. A recovered live
Host accepts only the exact admitted supplement. A local real-SDK fixture
verifies one supplement during an original recovered task, two usage records
and one canonical answer, without repeat dispatch or restart replay. This does
not complete multi-command ordering, cold later-step recovery, lost-acknowledgement
reconciliation, monetary settlement or production rollout. The new steering
switch and existing recovery defaults remain off. See
[Steering implementation and remaining gates](superpowers/plans/2026-10-16-steering-lineage-and-recovery.md).

## Cold pending steering acceptance

Original-run recovery now adopts separately admitted pending command RPCs and
uses exact per-message native maintenance bindings. Real local Host-death tests
verify one/two supplements, retained prior calls/logs/admissions, one canonical
answer and refusal of reserved or changed commands. This is local scripted-model
pending-input acceptance; later claimed steering, terminal acknowledgement and
cost reconciliation, rollout and the other inventory rows remain incomplete.
See [the staged plan](superpowers/plans/2026-10-16-steering-lineage-and-recovery.md).

## Later claimed steering checkpoint

The original ordinary factory now restores only admitted, unreserved later
claims after a verified closed-step boundary. Exact command proofs survive
preset setup; old logs, usage and authority are not rewritten. Real local
single/double claimed-input Host-death cases and paired refusal cases pass.
Historical terminal acknowledgement reconciliation, money/unknown outcomes,
rollout and the full capability inventory remain unfinished. See
[the staged plan](superpowers/plans/2026-10-16-steering-lineage-and-recovery.md).

## Running completion delivery checkpoint

The original ordinary Worker now checks native RPC/answer coverage and durable
product acknowledgement inside final publication while its Runner is live.
The same native iterator continues for later commands; no new prompt/planner is
introduced. Local SDK boundary and lost-ack cases prevent an old answer from
ending a task with a later command running. Historical terminal recovery,
unknown money, explicit Goal reactivation and rolling/production acceptance
remain separate open gates. See
[the staged plan](superpowers/plans/2026-10-16-steering-lineage-and-recovery.md).

## Historical ordinary source inspection

A separate internal bearer-authenticated terminal source endpoint now verifies
owner/conversation/Session/run/command and an exact expected run version. It
returns hashes and product state without raw text or an execution lease. Native
acceptance is always unverified. It cannot resume cancelled work, create an
Agent, repair acknowledgement, or settle cost. The live steering/lease contracts
are unchanged. Native history/admission/entry joining and atomic historical
repair remain incomplete. See the steering implementation plan.

The isolated native historical observation factory now joins exact product
lineage, raw persisted inputs, official invariants and immutable admissions/
reservations. Real local SDK cases verify lost-ACK/Host death, raw open steps and
unchanged stored bytes, without new model calls or Agent activation. It does not
yet provide deployed historical ACK/final delivery repair. Unknown execution,
fees, upgrade/rollback and the other capability rows remain separate open gates.

### Authenticated historical observation transport

The verified reader is now available through explicit trusted Host configuration
and dedicated bearer-authenticated readiness/history endpoints. The Gateway
Client enforces exact request scope and returned observation contracts. Real
local SDK cases now use this HTTP path rather than test-only file exchange,
retaining unchanged-byte/call/state checks. The capability defaults absent/off;
it does not enable replay, automatic ACK repair or historical final publication.
A future writer must use a separately versioned complete product-source digest
and atomic idempotent repair checks, not treat current observation IDs/version
as mutation authority. See the steering plan for remaining gates.
