# PilotDeck capability and implementation reference

The original owner publication chain now includes preparation, separate target
approval, admission, native file Apply, original history and explicit mobile
recovery. Selected index stage/unstage has its own original admission, native
dispatch/status/control and workbench entry; see the
[selected-index implementation and acceptance](implementation/2026-10-21-index-selected-apply-and-mobile-recovery.md).
These paths reuse the original physical database, native family, Worker and owner
review. Configured native index actions do not enable commits, destructive or
remote operations. Local synthetic/SDK/browser evidence remains distinct from
the still-open complete process/platform/provider/deployment matrix.

The dated milestones below are retained as development history. Their earlier
"not implemented" statements describe those increments, not the current total
state. Use the linked implementation records and complete ledger together;
neither the newer Git entry nor a green local gate certifies all26 capabilities.

Jot's reference scope covers all PilotDeck functions and implementation mechanisms, not only its interface or headline features. This checklist is not a claim of complete parity.

For the current remaining work, dependencies and parallel implementation
assignments across all26 capabilities, use the
[full-chain execution ledger](superpowers/plans/2026-10-17-pilotdeck-remaining-full-chain.md).
Its three source-audit records distinguish implemented paths from missing product
entry points and from real-provider/deployment acceptance.

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

## Current native Git hosting milestone

The latest [original publication family and native transport increment](implementation/2026-10-20-publication-family-and-native-transport.md)
adds per-member historical work placement, resident/cold SDK custody and
authenticated publication dispatch through the original Host. Actual Gateway
composition and separate-process recovery have focused acceptance. Public
owner Apply/recovery controls, broader Git/file operations and full-ledger
acceptance remain open; this does not complete capabilities 8, 14 or 15.

The original pending work review now displays complete frozen base/result
inventories, selected objective and recomputed diff through the existing owned
read. See [review evidence and remaining publication](implementation/2026-10-20-complete-work-review.md).
Task acceptance and artifact delivery remain distinct from applying results to
the configured checkout; Git/checkpoint activation still depends on that chain.

Finalized isolated text work also has an internal historical source reader that
verifies original acceptance, inspection, native completion and every written
version's immutable bytes. It works against read-only SQLite without renewing
execution authority. [Source evidence and limits](implementation/2026-10-20-finalized-work-sources.md)
remain distinct from target publication and recovery. The subsequent
[internal target review](implementation/2026-10-20-work-publication-review.md)
binds original source and configured target in a separate immutable owner review.
It does not dispatch writes; producer custody, recovery and product entry remain
unimplemented parts of that chain.

The [original publication admission](implementation/2026-10-20-workspace-publication-admission.md)
adds an explicit source-bound acceptance and a distinct operation kind to the
same project reservation/family system, with tested offline schema preservation
and crash rollback. It blocks original shared writes and Worker claims; it does
not dispatch files, prove deployed pool drain or complete native publication.

Optional original native hosting uses an authenticated local pipe/socket.
Separate-process installed-SDK tests stage reviewed bytes and observe parent
approval revocation in the same physical database. This is internal hosting,
not public Git write activation or full parity. See
[native Git transport](implementation/2026-10-20-native-git-local-transport.md)
for prerequisites, verification and remaining publication/UI/deployment gates.

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
Acceptance writers require protocol-2 complete product-source binding and atomic
idempotent repair checks. Legacy protocol-1 observations stay read-only. See the
steering plan for remaining gates.

An opt-in terminal ordinary acceptance consumer now revalidates complete source
digests and atomically records the accepted user message, command and immutable
receipt without replay or canonical final publication. Local actual-SDK Host
death/lost-ACK tests and reopened-DB retries pass; cancellation, concurrent repair,
source mutation, rollback and owner deletion have explicit checks. Defaults
remain off. Final-answer/all-command recovery, unknown fees and deployed parity
remain separate open gates.

Historical final recovery now has a full read-only product-source snapshot,
including zero or multiple steering commands and the existing canonical answer
identity. It exposes hashes and state only; it refuses deleted/conflicting
answers, cancellation, newer work, active leases and foreign scope. Ten targeted
regressions pass. This is the source stage: native all-command completion proof,
artifact/file integrity and atomic replacement of the same canonical message
remain required before final publication. No production configuration changed.

A detached full native-completion reader now verifies the full ordinary source
and admission set, official inbox/Goal projections and raw closure. Shared live/
historical output interpretation preserves reasoning, artifact references and
file presentations. A pinned local DSH characterization adds no model/tool calls
when reading the disposed Host's history. This reader has no enabled endpoint
or automatic publisher yet; versioned transport, output integrity and canonical
publication CAS remain open gates. See the steering recovery plan.

The full ordinary historical completion reader now has a separate opt-in trusted
Host transport and validated Gateway Client. Real Host history tests use the
complete product-source binding and retain unchanged logs/model calls. Product
runtime cursor and DSH controller Session identities are independently checked
using the existing Worker mapping. No canonical publisher is enabled; output
integrity, atomic same-message recovery and deployment gates remain open.

The atomic final-publication core now repairs lost supplemental user messages
and one canonical answer together, preserving its existing ID when present.
It validates actual output bytes, retains old/unknown candidate provenance and
stores an immutable post-state receipt; repeated/reopened recovery does not
replay native work or resurrect deleted output. Two actual Host crash cases
pass. Automatic production consumption, channel correction/holds, reload
ordering and the wider accounting/deployment/full-capability gates remain.

Historical reconciliation now emits registered product projection events.
The UI moves the same completed answer behind its supplements, and snapshot/
message-page reads use immutable publication time for the same order after
reload while retaining original creation dates. Public event-schema/reducer
checks cover this boundary. Full channel queue/correction/hold integration and
automatic production consumption remain required in the recovery plan.

Historical final channel recovery now composes the real snapshot and policy
with immutable final/recipient intents, mutable delivery state and the existing
outbox in the same publication transaction. It is opt-in through a trusted
ChannelDeliveryService instance on the exact same database connection. The
publisher does not create a new queue, initialize channel schemas or call a
provider. Without this explicit composition the original channel gate remains.

Only proven undispatched old bodies can be superseded. Known delivered bodies
receive a labeled correction; matching effects are reused. Unknown/partial
sends stay held, and later receipt reconciliation uses the same frozen targets
without model/native work. Recipient revocation retains unknown provenance.

The existing provider worker rechecks the immutable intent, original run and
Session, canonical body, original recipient binding and effect identity before
sending. These restrictions precede and preserve task/reply/digest permission
gates. Independent file/progress effects keep their existing intent. Replacing
a Session or mutating a granted effect cannot bypass history checks. Startup,
process-competition, rollback and synthetic-provider cases cover the local
composition; actual SDK cases preserve original logs/admissions and model calls.

The owning Worker now has a separate opt-in original-run observer and frozen
held-outcome follow-up loop. It requires original input recovery/steering and
strict trusted history readiness. Persistent observation claims coalesce reads;
they do not grant execution, reset native reservations or settle money. The
loop follows only original owned scope and uses the Worker's shutdown signal.
Default-off behavior, actual Worker startup and two actual SDK historical
cases are tested locally, including independent observation processes.

Real-provider acceptance, monetary reconciliation, large-output performance,
production rollout/rollback and the full upstream capability inventory remain
unfinished. Production defaults are unchanged.

Historical final sends now enter the existing outbox as `historical_pending`.
Pinned earlier notification consumers cannot claim this state; a compatible
consumer also requires the immutable historical grant and matching queued
intent, then performs all original send checks. A database trigger isolates
earlier producer inserts in their original transaction and bootstrap isolates
existing proven-unsent rows. Prior attempts remain unknown with receipt/lease
facts retained. Do not downgrade these rows to ordinary pending during rollback.
Earlier unsupported policy may hold delivery; a compatible observer resumes
the same identity. Already-authorized legacy in-flight calls cannot be undone:
drain old producers/consumers before enablement. This local compatibility gate
does not establish complete fleet, event, real-provider or production acceptance.

Original ordinary steering now commits hash-only fallback prohibition before its
native call. A lost reply followed by configuration rollback cannot turn that
reserved input into a fresh run in the current dispatcher. An existing-database
insert guard also rejects the pinned earlier dispatcher's fallback message;
original deterministic publication and cancellation remain usable. This does
not retroactively protect earlier unreserved commands or prevent an old live
native prompt. Full execution-pool draining and deployment acceptance remain
required; custody never proves native acceptance or settled money.

Historical output hashing no longer runs inside the SQLite write lock. Actual
verified descriptors remain open while the original atomic publication checks
catalog/source/permissions and file identity/change times, including final commit.
The opt-in [load probe](HISTORICAL-OUTPUT-LOAD.md) measures actual 1/32/200 MiB
local files against a separate writer. The pre-fix 200 MiB cases caused busy
failures; the final three-round local run records none, with publication locks
5.59–6.94 ms. Receipt retries and racing publishers also avoid byte reads inside
the transaction. This does not complete storage/retention, real-provider, fleet,
production or all-capability acceptance; filesystem assumptions remain explicit.

## Always-on discovery implementation started

The [complete discovery/work-cycle plan](superpowers/plans/2026-10-17-always-on-discovery.md)
maps the upstream scheduler, discovery/work/report, workspace and reviewed apply
flows to original DSH/Gateway contracts. The first pure eligibility evaluator
is implemented and locally tested: explicit owner/project/role scope and revision,
fresh observations, native idle, recent human input, cooldown, existing budget
holds, background capacity, dormant signals and reservation/cycle gates.
Its positive result is advice with `execution_authorized:false`, never admission.
No scheduling loop, configured owner policy, workspace, apply route or model call
is enabled by that module. The factual collector, persistent policy/admission,
original DSH planning/execution/report, work-cycle isolation/apply, UI and deployed
acceptance remain to implement. Persistent configured tasks are not full
Always-on discovery. Upstream unattended permission bypass is not transplanted.

The [unlimited task-run prerequisite](superpowers/plans/2026-10-17-unlimited-task-runs.md)
is now implemented across the original table/admission, schemas, capabilities,
workspace projection and built UI. Explicit null retains counts and pause/resume;
finite defaults and once triggers remain unchanged. Actual SDK tests preserve the
same occurrence/native Goal and reviewed file delivery; the built BFF/Gateway UI
recovers a lost nullable save without creating another task. This does not install
the discovery collector, policy/signal scheduler, isolated workspace or apply
workflow. Full 26-capability and production acceptance remain open.

The native-idle observation prerequisite now has an opt-in authenticated Host
route and a strict Gateway client. It reads existing live Agent facts or stable
cold Session projections; missing/changed facts stay unknown and active persisted
Goals stay busy. Actual pinned Host restart verification leaves the paused Goal
unchanged, creates no Agent after restart and invokes no model. This is current
Host evidence with `execution_authorized:false`, not a project collector, fleet
idle proof, completion receipt or occurrence admission. The standard profile
keeps it disabled pending the remaining discovery integration and acceptance.

The project activity source adapter now combines original scoped SQL records,
existing workspace readiness and the authenticated Host observation client.
It includes archived conversation and native child Session identities, releases
read transactions before network IO, and rejects changed/stale sources before
returning idle evidence. It creates no records, directories, Agent or inference.
It remains a source component: durable discovery policy/signals, existing budget
and background-capacity integration, original occurrence admission, isolated
work cycles/apply, UI and deployed acceptance are still open.

Durable discovery configuration is now available through owned role API routes,
with default-off saving, explicit enable/pause/stop, role revision revocation and
immutable atomic command receipts. Internal source signals are durable and
deduplicated; own generated events are excluded and ingestion never resumes a
paused/stopped policy. These are configuration/evidence foundations. They do not
install the watcher, original occurrence admission, DSH work cycles or UI, and
provide no new model/tool/budget authority. Full parity acceptance remains open.

Budget/background readiness now has read-only projections over the original
ledger and Coordinator. Task-root unknown usage includes native-style shared-root
members rather than only primary occurrence run IDs; unrelated daily-budget
siblings remain independent. Background observations reuse the exact claim SQL,
preserve foreground priority, and do not create a lease. They are not native idle,
hardware capacity or admission. Source-bound occurrence admission, remaining
reconciliation, coalescing/reservations and execution integration remain open.

Explicit policy enable now atomically prepares one immutable original task/budget
identity with an unscheduled managed trigger. Pause/stop/resume reuse it and keep
the accumulated run count. Ordinary task/timer paths cannot admit it; a SQL guard
currently refuses all its occurrences until the full admission protocol is ready.
Built UI/BFF verification covers the managed card and lifecycle without any model
run. Preparation is not an executing discovery loop, a completed work cycle or
deployed acceptance; all remaining source/admission/DSH/workspace/UI gates remain.

Trusted source ingestion now runs on the existing ready Worker maintenance loop:
role-bound chat user-input identity metadata and owned immutable file versions
become deduplicated journal signals. It reads neither message bodies nor file
blobs and creates no run, lease or model attempt. Recorded output producers are
checked against original owned cumulative budget scopes; discovery-derived
outputs in the same project are excluded, including other discovery roles.
Unknown recorded producers hold their file path's subsequent versions. Direct
owned versions without a producer are base-file metadata, not proof of human
authorship. Private inputs from another role/owner are not promoted. Paused
policies collect without resuming; off/stopped/revoked policies do not collect.
This does not prove physical watcher coverage, source editing/revision support,
coalescing/dormancy, transactional occurrence admission or a DSH work cycle.

The next admission increment is now implemented internally: one journal head
reserves one original planning occurrence, without another task/Agent/budget loop.
An immutable receipt carries policy/role/task generation, source-head/activity
digests and original budget-policy revision. A deferred occurrence FK and original
transaction prevent orphan reservations; competing fixture processes create one
queue entry. Only exact observer-issued fresh idle receipts can be revalidated;
no Host IO occurs while the writer is held. Policy/source drift, unknown idle,
original budget/capacity holds and unaccepted prior cycles refuse admission.
Planning workspace operations are restricted to reads, and stop/role/policy drift
revokes the run. This is a callable trusted controller, not an automatically
running Worker discovery dispatcher. Discover-and-work, source-backed structured
plans/reports, accepted no-plan dormancy, isolated work/apply, UI and real-provider/
rollout acceptance remain open.

Structured discovery proposals/reports now reuse original task operations and
the existing workspace tool. Own task metadata can advance; project mutation,
memory mutation, messages and delegation remain denied. Context and proposal
readback are paged, source text is pinned and chunked on demand, and images are
not fetched. Actual source-read receipt ranges establish batch coverage; model
coverage claims or unrelated ordinary reads do not establish no-plan coverage.
Proposal dedup follows owned admission/source and normalized work, not a title or
new call ID. The server derives all report plan IDs so a bounded explicit-ID list
does not impose a plan-count ceiling or omit proposals. Current report proof is
required before native completion proposal and enters the original frozen business
review/certificate snapshot. Report storage is not acceptance, no-plan dormancy,
project application or completion. Dedicated discovery SDK/provider execution,
accepted dormancy, isolated work/apply, full UI and automatic lifecycle dispatch
and production/rollout acceptance remain unfinished.

Dedicated local discovery canaries now exercise the official DSH SDK with the
real Gateway/Worker and a scripted local model, including source-backed proposals,
original owner review and native completion/publication. Accepted no-plan
dormancy is derived read-only from these original receipts, not model claims or
completed status projections. A Worker restart preserves the review/completion
boundary; unchanged sources stay dormant and a new owned revision can queue the
same original task again without resetting its budget. Queueing a second cycle
is not proof it executed. Automatic dispatch, failure/wait recovery, isolated
work/reviewed apply, full UI and real-provider/production acceptance remain open.

Source-integrity recovery now has a dedicated actual-SDK/scripted-model case:
failed pinned reads produce no success receipt or coverage; the original native
Goal waits for input and resumes its same occurrence/budget after byte repair.
Fixed repairable source/report errors are distinct from authority rejection;
arbitrary server detail text is not forwarded. This is one controlled fault,
not exhaustive IO/crash recovery or production acceptance.

The role-bound discovery policy form uses the existing owner API and command
receipts: default off, save separately from enable, pause/resume/stop and explicit
retry after response loss. Its current explanation retains the missing automatic
dispatcher boundary. A source inventory, UI render or scripted API request is
not equivalent to actual browser interaction or executed work-cycle acceptance.
Isolated execution, owner-readable cycle/report projection and exact frozen-diff
review/application remain separate required deliverables.

Owner history now pages the original discovery admissions, reports and proposals
and verifies canonical acceptance independently of runtime status. The role
workbench previews those records and their limitations. Actual built-browser
tests exercise original BFF/API records and proposal pagination; selected actual
DSH SDK cases verify accepted history after original native publication, with a
scripted local model. These are separate evidence from provider/production use.

A snapshot-copy artifact provider now streams explicitly selected binary/text
files and empty directories into a separate root and inventories scoped results.
Frozen manifest differences retain exact content/mode/type/add/delete/unique
rename facts. Structural ancestors never become modification authority for a
selected child. These helpers do not execute tasks, apply changes or provide an
OS sandbox. Durable artifact recovery uses the original bindings described below.

Owned work-cycle resources now freeze selected proposals from a canonically
accepted original report, source/policy/role/task identities and the original
cumulative task budget scope. One open resource occupies an owned workspace;
explicit resource close neither completes the task nor deletes files or refunds
usage. Immutable command receipts recover lost replies without renewing authority.

A private preparation journal binds one snapshot intent to that resource and a
trusted host configuration. The snapshot provider can recover a committed artifact
across instances/processes, checking original manifest/root identities and actual
scoped files. An intent without a ready record stays uncertain; retry does not
silently copy again. The internal workspace manager combines those checks and
retains the distinction between copied context and proposed writable paths.
Root identities and recovery records are internal, not browser inputs or public
report fields. Directory identity and selected-entry types must still agree at
commit; a successful logical policy guard does not substitute for filesystem checks.

This increment does not install an external project-to-physical-root registry, isolated DSH
execution, an OS sandbox, Git provider, automatic discovery dispatcher or reviewed
application. Before execution/apply, actual source-base drift, permissions, scoped
memory and original native task continuation still require their own integration
and acceptance. Full26 capability and real-provider/deployment scope remains open.

The default logical Workbench project source now has a direct byte-stream bridge:
all current owned versions become pinned private source facts and logical paths
in the isolated snapshot, rather than copies of the blob container. Source
revisions detect writes before collector polling; verification reads actual
bytes as well as metadata. Empty/new targets, binary internal fixtures, more than
200 files, exact restart recovery and unknown preparation are covered locally.
Project-scoped observation avoids unrelated database writes cancelling a copy;
transactional schema verification cannot pollute its committed cache. Large
project materialization still has significant guard/IO overhead. This completes
the logical source artifact connection, not original DSH work admission,
plan-only isolated file execution, reviewed application or production acceptance.


The [original request remount continuation](implementation/2026-10-21-git-original-request-remount.md)
also retains unconfirmed atomic commands across page reload in an authenticated
owner/project browser namespace. Explicit same-key confirmation is separate
from fresh original server reads and later native dispatch. This closes the
pre-commit page-loss gap locally, not broader Git or all26 acceptance.
