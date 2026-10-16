# Persistent tasks and shared workspaces

Owned memory records now have a history view and an explicit restore
confirmation. Restoring an earlier active revision creates a new unverified
version, retains its sources and records which revision it replaced. It cannot
revive deleted, superseded or expired memory, extend the current expiry, or
restore an Agent's revoked access. Concurrent edits require a reload; a lost
response can retry the same idempotent request. This is individual revision
restoration, not automatic memory extraction or Dream consolidation.
The workflow is informed by [PilotDeck's white-box memory design](https://github.com/OpenBMB/PilotDeck).
Jot stores these revisions in its existing owner-scoped SQLite ledger.
History opens the newest 50 revisions and provides earlier-page navigation;
exports retain the complete authorized history. Successful restore receipts
commit with the memory change, so the same request survives a server restart
without creating another revision. The browser retains an unresolved command
only while that page remains open. After a forced reload, inspect the current
history before submitting another restore; browser command recovery is not
persisted across reloads.

Task acceptance cards include frozen-file review: inspect a small text/image or
download the verified version before accepting. HTML/SVG remain literal text.
Changing the current workspace file does not change that version; accepting,
rejecting, expiry or authority revocation closes the old review route. This read
does not publish a final attachment or approve the task. See the
[Gateway review limits](packages/gateway/README.md#reviewed-workspace-attachments)
for size, concurrency and response-deadline behavior.

The extended gateway provides owned Agent roles, teams, durable task occurrences,
shared files, memory proposals, member mailboxes and an execution evidence ledger.
These APIs belong to `packages/gateway`. The root demo runtime is a separate entry
point. Its homepage links to `/workbench.html`, which exposes the management UI
when the local gateway proxy is configured.

Set `JOT_WORKBENCH_URL` to the gateway's HTTP loopback origin,
`JOT_WORKBENCH_OWNER` to the local user's stable owner ID and
`JOT_WORKBENCH_CSRF_TOKEN` to the gateway's configured CSRF token. Also include
the root server's origin in `GENERAL_AGENT_ALLOWED_ORIGINS`.
The proxy supplies the owner server-side and does not expose the gateway token
to the browser. This is a single-owner localhost setup; it is not authentication
for hosting the root server publicly or serving multiple users.

## Local verification

Use Node.js 24+ and Python 3.12+ available on PATH. From `packages/gateway`:

```sh
npm ci
npm run build
npm test
```

The build generates original neutral report, copy brief and evidence spreadsheet
templates. It does not require a personal template directory. Document editing
requires a configured Python worker and the appropriate Office dependencies;
tests requiring unavailable Office tooling are explicitly skipped.

From `packages/session-adapter`, run `node --test test/*.test.mjs`. Its ledger tests
also import the adjacent gateway source. These tests do not prove a live model,
Session host or production browser integration is available.

From the repository root, run:

```sh
node --test scripts/verify-public.test.mjs
node scripts/verify-public.mjs .
```

The source scanner checks likely credentials and private endpoints. It excludes
dependency directories, generated output and runtime state. It is a heuristic,
and neither scans Git history nor replaces a human review of the staged diff.

## Runtime prerequisites

### Native conversation Goals

The extended Gateway exposes `GET /v1/conversations/{id}/goal` and `POST` to
the same path with `{action: "pause" | "resume" | "stop", id, revision}`.
Only the existing owner-bound ordinary Session is addressed. Clients cannot
submit a Session ID, create a Goal, mark one complete or control a role/task
Goal through these routes. Existing CSRF, idempotency and revision checks apply.
Configure the existing `GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE` and loopback
`GENERAL_AGENT_SESSION_ADAPTER_URL` on the Gateway to connect its native client.

DSH owns Goal creation and automatic rounds. The runner observes the same stream
across active rounds; it does not send another prompt to simulate continuation.
Paused or blocked Goals suppress the legacy crawl-follow prompt. An ended stream
while continuation is armed is an interrupted outcome, not completion.

After Host restart, reads use the official persisted projection without loading
an Agent, calling a model or rearming a Goal. A persisted active phase is shown
as disarmed until explicitly resumed. Missing Sessions return null; unavailable
or corrupt projections return an error. Reads never activate an Agent.

Cold pause and stop can use the official ordinary Session resolver when the
stored preset is allowed, both durable inbox queues are empty and the official
inspection shows a closed, contiguous turn history. The operation rechecks the
exact live Agent and idle inbox, uses native maintenance, and flushes persistence
before acknowledging. Stop uses one native `clear` tombstone, not pause followed
by clear. Pending input or an open turn returns `409 GOAL_CONTEXT_RECOVERY_REQUIRED`
without activating the Agent; this definite refusal is distinct from an unknown
mutation result. It does not clear, replay or automatically process that input.

  The ordinary conversation composer includes **+ → Goal mode**. The status card
  shows the objective, native phase and admitted rounds, with pause, continue and
  confirmed stop controls. Pause stops subsequent rounds; it does not cancel an
  in-flight tool operation. Unknown control replies retain the original revision
  and idempotency key; returning from the conversation is blocked until resolved.
  Goal mode sends the explicit human request through the original message path
  and native model tools. It requests the maximum safe integer round count, not
  a second scheduler or a change to token, currency or permission policy.

  Continue now uses an atomic 202 admission receipt and message-free original
  Worker run when explicitly enabled. The UI separates accepted execution from
  native Goal phase, checks readiness and follows the queued run without another
  human prompt. Both Gateway and Host switches default off pending complete
  queue-consumer rollout, crash-recovery and deployment acceptance. A running
  product status is not evidence of a native follower. See
  [Goal continuation](docs/GOAL-CONTINUATION.md) for configuration and remaining
  boundaries; the official model tool still cannot imitate human resume.

  After building, `npm run test:goal-ui` uses the optional Playwright dependency
  and a local browser (Edge on Windows, installed Chromium elsewhere). It serves
  the actual built workbench with synthetic API fixtures, covering the plus menu,
  exact-request retry, pause/continue/stop, ordinary/role separation and a mobile
  viewport. No model, remote website or production data is used. This is UI wiring
  evidence, not full Goal execution or production acceptance.

The separate official-Host probe is:

```sh
node --test packages/dsh-host/test/cold-goal.test.mjs packages/dsh-host/test/cold-goal-controls.test.mjs
```

Set `JOT_DSH_RUNTIME_MODULES` to the installed locked SDK packages. The probes use
temporary profiles without provider credentials. They cover read-only restart,
cold pause, clearing active and paused Goals, competing CAS requests, durable
restart results, refusal of parked input before activation, and zero model calls.
They do not prove a complete interrupted-input recovery or observed resume flow.

Copy the gateway `.env.example` to an untracked `.env`. Configure independent
authentication tokens, allowed origins, writable database and workspace paths,
and the Session adapter endpoint. Keep all credentials outside the repository.
Configure the actual Session host and register the adapter before enabling task
execution. The adapter manifest records its upstream peer versions; a successful
unit test does not establish compatibility with another upstream version.

Model-enforced tasks require an explicit pricing and budget policy. Roles and
task occurrences retain owner, project and workspace scope. A member's result
is supporting material; it cannot independently finish its parent's task.

Delegation is disabled until a task-specific grant authorizes a team and frozen
members. The worker reserves one foreground slot. Concurrency 3 admits one
background lead and one member; concurrency 4 admits a lead and two members.
Concurrency 1 remains the conservative default, and does not provide background
capacity. Increasing the worker limit alone does not grant collaboration rights.

Changes to membership, role authority or task grants are checked again before
execution and retries. Unknown execution outcomes retain their admission and
accounting state until reconciled; retries do not manufacture completion proof.

## Release boundaries

The management UI, gateway backend and Session bridge are included. Role chats
use gateway snapshots and replayable SSE, keep their own conversation IDs,
send queued messages, cancel a versioned run, answer questions and confirm
approval cards. Lost send receipts retain the original message and retry key.
Final replies replace streaming shells, and generated files appear after their
successful reply with up to three initially visible downloads.
Optional external notification adapters, live provider integration and
end-to-end deployment acceptance must be verified separately. Do not infer
these capabilities from a passing backend test suite.

## Task creation and draft recovery

### Attachment transport status

The same-origin workbench proxy now accepts gateway upload initialization and
completion routes, plus binary `PUT /v1/uploads/{id}/content` with the original
bytes and a 100 MiB transport ceiling. PUT is not enabled for unrelated resources.
Owner and gateway authentication remain fixed by the host, while browser writes
still require local CSRF and origin checks. Oversized uploads and incorrect body
types are rejected before forwarding. Gateway quotas and declared-size/hash
checks still apply independently.

Role and ordinary gateway chats now offer file selection, capability-derived
size limits, explicit upload retry, removal of confirmed or rejected selections,
and text/image preview. File-only messages are supported. User attachments stay
beneath their message; generated downloads appear after successful final replies,
with three initially visible and expansion scoped to each answer.

Each upload stage retains its original file, body and idempotency key after an
unknown response. Unknown uploads cannot be replaced or sent as ready. The send
retry also retains the exact uploaded references and original message. Confirmed
uploads refresh the authoritative snapshot because completion does not emit an
artifact SSE event. Pending files are held in memory in the current tab only;
refreshing before sending does not restore those drafts. Submitted attachments
are recovered from the gateway snapshot.

To verify response loss against an isolated real loopback gateway, install the
optional Playwright dependency and its browser, build the root UI, then run:

```sh
node scripts/verify-chat-uploads.mjs init
node scripts/verify-chat-uploads.mjs content
node scripts/verify-chat-uploads.mjs complete
```

On Windows the script uses installed Microsoft Edge; other platforms use
Playwright Chromium. Port 3058 must be free. The checks use synthetic files,
reject external browser requests, and run no model or background worker. They
verify one upload and artifact per selected file and one message/run after lost
upload and send responses, text/image preview, retained multi-file selections,
reload and mobile overflow. The script also registers four synthetic outputs
through the fenced coordinator and tests live `run.artifact` projection,
success-only downloads, three-item expansion, exact download bytes and stable
ordering after reload. It does not run a model or prove production acceptance
or whole-product backup.
Portable-root uploads remain a separate runtime path.
Image previews use owned same-origin downloads rendered as temporary blob URLs;
the page permits `blob:` only for images while script and network policies remain
same-origin. Blob URLs are released when the preview closes.

### Upload process recovery

New authenticated upload requests reserve an atomic receipt protocol in the
existing idempotency table. Initialization and registration commit their business
rows and successful receipts together; content completion does the same. An
error cannot overwrite another in-flight success. A stable final destination
allows recovery after rename but before registration, only after checking its
actual size and SHA-256. Old pending requests without the protocol remain held
for reconciliation instead of being recreated from guessed matches.

Each content writer has a five-minute lease renewed every 20 seconds and a
separate temporary-file generation. Active writers cannot be taken over.
Retrying an expired identified writer uses a new file; a resumed obsolete writer
cannot publish, reset the replacement state or delete the replacement file.
Legacy partial streams without a writer identity remain held. Abandoned
generation files are retained; this mechanism does not perform retention cleanup.

From `packages/gateway`, `node --test test/artifacts/upload-recovery.test.mjs`
tests failed SQLite commits, unchanged requests, owner isolation, old-protocol
holds and writer fencing. Its isolated Node fixtures exit during each receipt
commit and reopen the database. The content fixture simulates elapsed lease
time after the writer exits; production waits for actual expiry. This verifies
process-exit recovery, not power-loss durability or a live production upgrade.
Enable gateway authentication/CSRF as described above for durable HTTP receipts.

Completed role messages can seed an editable task goal and immutable source IDs. The My Conversations entry also opens owned gateway conversations (up to the latest 100 active items); ordinary-chat task creation leaves the role empty until you explicitly choose one. The server validates the source and selected role workspace/project scope before saving. This does not import portable-root conversations into the gateway. The five-step form reviews role/goal, trigger rules, run/model budgets, notification delivery and the final configuration. Application-local results are the default; optional delivery references only existing verified owner bindings. Task creation and notification settings commit atomically, and an identical retry never reapplies a later-revoked authorization. Editing a task preserves its separately managed notification settings. Bounded autonomous reply remains separate integration work.

In a task's execution detail, **Notifications and delivery** can bind a mailbox
when the server advertises `email_bindings`. Enter an address, request the
verification email, then paste its complete code. Only a verified channel can
be selected in task notification settings. Verification alone does not turn
on task messages. Email application and confirmation retry preserve their
original request after a lost response; no automatic resend occurs. Codes are
not written to browser storage. Reload restores pending challenge IDs from the
owner-scoped API. A channel may be revoked independently of a running task;
queued delivery checks its current binding before sending. Live mailbox arrival
and production execution still require separate acceptance.

With a configured gateway CSRF token, capabilities supplies an opaque authenticated-owner draft namespace. Same-tab session storage preserves drafts and unknown POST/PATCH receipts across navigation and reload. Restoration does not execute anything. Retry requires an explicit click and preserves the original body and idempotency key; clearing or editing an unknown receipt is blocked. Known rejection allows correction. Successful storage records clear the submitted draft. Storage failure blocks the network save instead of silently weakening recovery. Closing the tab, clearing browser storage or rotating the gateway authentication secret ends this client recovery scope; the server task ledger remains authoritative.



### Reply-policy configuration boundary

The extended gateway accepts an optional `reply_policy` during atomic task creation and exposes `GET` / `PATCH` `/v1/persistent-tasks/{task_id}/reply-policy` for owned versioned settings. Updates require `expected_version`, the existing browser write authorization and an idempotency key. Ordinary task edits cannot change this authority. The modes are report, draft, review and bounded auto reply; non-report settings require a verified target, direction, evidence, limits and an expiry. Current `task_reply_policy: true` means configuration support only: `task_reply_execution` remains false. The five-step creation form and task-detail reply editor now save these settings. The detail editor reviews the target, direction and limits before an independently versioned update; selecting report revokes future reply authority. Unknown update receipts persist in authenticated-owner, task-scoped same-tab storage and retry the exact original command only after an explicit click. Editing versions are captured when opening the editor, so intervening changes cause a conflict rather than being overwritten. Dispatch now captures immutable occurrence authorization and supplies planning context to the existing DSH session; current role, task, target, policy and run fences can reject a previously captured scope. Legacy role adapters without persistent epochs run reports only. This scope is not a delivery receipt. The existing workspace tool supports tasks.reply_draft (text and current-occurrence verified tool receipts) and tasks.reply_drafts. Review mode uses the existing browser interaction card with task_reply_review purpose and an immutable payload digest; approving records only that candidate, without queuing another planner or claiming delivery. Draft-only mode stores a candidate without approval, and bounded mode still requires a separate scope/risk decision. The posting adapter, semantic scope checks and actual provider acceptance remain integration work. Do not describe a saved policy as an executed reply or enable a posting worker from this flag.

Reply delivery readiness now includes immutable reviewed-payload checks, live authority checks, quiet hours, and transactional attempt reservations shared across tasks for the same owner and target. Reservations are retained rather than automatically released after ambiguous outcomes. This is a foundation only: the reply outbox, provider wiring, conversation projection, and bounded autonomous semantic/risk checks are not yet connected. Reply execution remains disabled; saving or approving a draft does not send it.

The host-only reviewed channel reply adapter now writes an immutable grant beside the existing delivery outbox, and the existing worker checks the exact draft, target binding, live authority, quiet hours, and reply attempt budget before provider I/O. Reviewed text is preserved exactly and is not combined into notification digests. Ambiguous outcomes are not resent; confirmed receipts recover without a second send. This has only been tested with isolated local provider fixtures. Browser-to-host dispatch, conversation reply projection, bounded semantic/risk checks, and production acceptance remain incomplete, so user-facing reply execution stays disabled.

Owned conversation replies can now be projected as completed assistant messages with no execution run. An immutable receipt retains source-task provenance; projection, event, and attempt slot commit together. Independent replies remain separate in the UI and do not trigger user-message or execution-result monitoring. Only completed assistant messages may have a null run identity, and event/payload null identities must agree. Host dispatch after approval is still pending, so user-facing reply execution remains disabled.

The host now scans committed human approvals and dispatches them transactionally to the conversation projection or existing external delivery outbox. Dispatch outcomes and deferrals survive process replacement; queued external messages are not reported as delivered. Browser reads never send. `GENERAL_AGENT_TASK_REPLY_EXECUTION=0` is the default; only `1` requests experimental host dispatch and existing workbench readiness is also required. User-facing execution remains disabled until reply history, bounded semantic/risk validation, and deployment acceptance are complete. A local browser fixture verified approval, host dispatch, target-chat display and reload without duplicates; it did not use a real model or external recipient.


### Current reply history and dispatch status

The preceding incremental notes describe earlier milestones. Current reviewed-reply host dispatch and conversation projection are connected behind the explicit, default-off host flag; user-facing execution capability remains disabled pending full acceptance. The owner-scoped, read-only replies endpoint paginates 50 drafts per page using a task-owned cursor. The execution detail shows approval, dispatch, deferral, delivery, cancellation and unknown outcomes separately. External delivery follows the existing outbox and receipts; a queue entry is not delivery, and delivery is not proof of reading. Recipient principals and raw provider receipts are omitted. Reading history never sends a reply, and unknown outcomes have no automatic resend control.

Local isolated browser coverage exercises human approval, host dispatch, runless conversation display, reopening history, reload and the target link. Backend tests cover foreign cursors, pagination, revoked authority, review denial/expiry and ambiguous external delivery. This uses synthetic execution events and local provider fixtures, not live model, external-recipient or production acceptance. Bounded autonomous scope/risk verification remains incomplete. Public source scanning is not a substitute for reviewing staged content, binary artifacts and Git history before publication.


Bounded autonomous reply verification now has an owned source-material prerequisite: web reads under the frozen autonomous policy may retain exact JSON, limited to 256 KiB per result and 1 MiB per occurrence across continuations. Other modes do not duplicate web content. Source reads verify ownership, occurrence, bytes and receipt hash; missing, unsupported or oversized results are unavailable rather than partial evidence. Embedded webpage instructions remain untrusted data. This does not certify scope or risk, enable automatic replies or expose source contents in the history API. Semantic evaluation, resource accounting and full source-retention lifecycle acceptance remain outstanding.


Local cold notification payload archiving and exact materialization are now available through an explicit administrator command. Hot delivery identities, terminal status, source references, authorization and deduplication remain intact. Read-through validates the archive against one SQLite snapshot; archived identities cannot be claimed for sending. This is not remote backup verification or scheduled production cleanup. See [cold notification archives](NOTIFICATION-ARCHIVES.md) for commands, private-storage handling and remaining deployment checks.

### Conversation history pagination

The owned conversation list uses signed, owner/project/state-scoped keyset cursors, valid for 24 hours. The signing material persists in the product database and is never returned by the API. The conversation picker displays up to 100 active conversations per page with previous, next and refresh controls. Opening an older conversation restores its existing snapshot without creating a new conversation or exposing internal session identities. Pagination follows live pinned/update ordering; refresh the first page to see newly created or repositioned conversations. This is not a frozen historical snapshot. Local isolated browser coverage verified pagination, older message restoration, reload and owner isolation with no model calls.

### Host-only bounded reply assessment

The optional compatible evaluator is now wired into the existing draft tool after
its database commit, under the same run lease and budget. A read-only host
eligibility check revalidates the complete immutable assessment against surviving
sources and its settled accounting receipt. It now feeds the existing send gate
and default-off host dispatcher. History distinguishes eligible, rejected and
pending assessments. Public execution capability remains disabled pending full
acceptance.
Captured provider responses now support explicit host reconciliation after
settlement/check-storage failure, without repeating the model request or charge.
Missing response or usage remains unavailable. See [reply judge setup and
boundaries](REPLY-JUDGE.md) for configuration, input limits, usage requirements
and the read-only inspection / explicit recovery commands.

`packages/gateway/src/persistent-tasks/reply-semantic.ts` now provides an independent host assessment path over the exact saved draft and complete owned web evidence. It freezes the input digest, claims one durable attempt, meters `reply-verification` through the existing root budget and stores an immutable settled result. Topic, tone, forbidden directions, low risk and no required user confirmation must all pass. Every non-whitespace part of the candidate must be covered by source references and exact source quotes; missing, unsupported or oversized source contents are unavailable, never silently truncated. Invalid or uncertain assessments are blocked even though the provider call remains charged. Structural quote checks complement an independent model judgment; they do not prove entailment themselves.

The assessor does not itself send, create another planner, expose a browser approval API or enable the public autonomous-reply capability. The existing send gate now revalidates settled assessment evidence, and the explicitly enabled host dispatcher can route eligible candidates into the existing conversation projection or delivery outbox. Delivery-worker authorization rechecks evidence and authority before provider access. Local browser coverage verifies waiting without sending, host projection, target-chat display and reload without duplication; it uses an isolated judge fixture, not a real model or external recipient. Real provider quality, pending-check recovery and deployment acceptance are still required. The trusted evaluator adapter must enforce its actual context/input limit without dropping evidence and return real normalized usage; per-dispatch quota-only emotion routes cannot substitute for token accounting here. A retained pending attempt is not automatically repeated after an ambiguous result or restart. Reconcile its actual budget/provider outcome before deciding recovery; do not delete the attempt to make a retry appear free.

### Local management lifecycle and response-loss recovery

Run from the repository root after `npm run build`, with port 3059 free:

```powershell
node scripts/verify-workbench-management.mjs
node scripts/verify-workbench-management.mjs lost
```

The isolated browser test starts the actual local gateway and BFF with synthetic
roles, then exercises role and team creation/editing/deletion, member messages,
shared/private memory isolation, memory correction/export and shared text files.
It restarts both services against the same local database and files and verifies
that confirmed data survives. It makes no model calls or external requests.
Fixtures, screenshots and exported memory stay in the ignored `.test-tmp` tree.

The `lost` variant drops fifteen successful mutation responses and retries the
original command with the same body and idempotency key. Pending fields, scope
selectors and workbench navigation are locked until the original result is known.
The original delete confirmation remains available for retry. A genuine version
conflict allows editing/rebasing; an in-progress receipt retains the command.

This mutation recovery is in-memory for the currently mounted page. The browser
warns before unloading an unknown command; it does not persist those commands
across a browser crash or prove native Team/Handoff, actual agent execution or
production acceptance. Role configuration copy, disable/re-enable and local JSON
export now have UI controls. Copy opens an editable form and creates a separate
member/conversation only after saving. Export contains name, instructions and
requested tools; it excludes identities, host settings, history and memories.
Instructions can contain your own private text, so review an export before
sharing it. Disabling uses a version-checked confirmation and revokes role
authority; enabling does not resend messages or resume paused tasks.
Role configuration revisions are append-only database records: updates, deletes
and replacement of an existing revision are rejected. Editing creates a new
version; existing run context stays frozen and current authority is still
checked separately. This does not prove termination of an already running
external host process.
The shared-file BFF route allows only the existing JSON
workspace-file PUT; it does not open arbitrary PUT or binary file operations.

The gateway has a host-only [web-decision budget grant foundation](WEB-DECISION-BUDGET.md).
It preserves original-run accounting and role authority but does not yet connect
the official MCP transport and external Python providers. Gateway tests alone
must not be used to claim that those provider calls are budget-enforced.

## Optional native Team bridge

[Native role integration](NATIVE_ROLES.md) documents the saved-role lifecycle, shared workspace and accounting, default-off deployment gates and remaining model-callable dispatch work. The lead retains planning and final-answer responsibility.

### Complete PilotDeck reference scope

See the [full capability and implementation checklist](docs/PILOTDECK-PARITY.md). All modules and recovery mechanisms remain in scope. Memory revision restoration does not claim full Dream consolidation parity. An unreleased preview database missing a required restore-audit compound foreign key fails startup with `memory_restore_schema_migration_required`; back it up and perform a reviewed offline migration instead of silently recreating its audit history.

### Reviewed memory consolidation

The workbench now exposes staged consolidation records for the selected project or private role. In the original DSH role conversation, ask the Agent to organize its memory: `memory.stage` freezes up to 25 current records and `memory.propose` submits bounded rewrite/duplicate-merge changes. The Agent cannot apply or roll back a batch. Open **Shared workspace → Memory → View consolidation** to inspect frozen sources and before/after changes, explicitly apply/reject, or safely roll back its exact resulting versions.

Staging and proposing leave live memory unchanged. Apply revalidates every frozen input in one SQLite transaction; any changed, deleted, expired or unauthorized source blocks the entire batch. Rewrites clear verification. Rollback creates new unverified revisions, never extends expiry and cannot overwrite later edits or revive another operation's deletion. Immutable snapshots, proposal/result receipts, original request keys and the existing DSH budget/lease guards survive backend restarts. Browser retry recovery remains current-page only; a forced reload requires inspecting actual recorded state.

Lists return at most 50 compact summaries, not repeated full source/proposal bodies. Individual record reads expose their frozen source trace. Each scope admits at most 10 pending drafts/proposals; reject obsolete proposals to release that capacity. There is no extra model provider or background planner. The installed rc2 SDK verification uses a local scripted model, so it proves wiring and accounting, not provider reasoning quality. Automatic message extraction, retrieval explanations and idle-triggered Dream execution remain separate unfinished capabilities.

Run the reproducible SDK probe after installing the locked DSH host and setting `JOT_DSH_RUNTIME_MODULES`:

```sh
node --test packages/session-adapter/verification/native-memory-consolidation-runtime.mjs
```

### Memory retrieval evidence

**Shared workspace → Memory → View retrieval records** shows the selected role's initial snapshots, continuation snapshots and explicit `memory.list` queries. It records the actual authorized candidate count, ordering method, keyword matches and selection exclusions. Keywords use the existing substring matcher; an adapter's ordering is not a confidence score. Empty queries preserve the existing scope order. This feature adds no model connection or per-guard RPC.

The log stores queries, immutable version references and algorithm statistics instead of another copy of the memory body. Detail reads recheck owner, project, role, active status, expiry and exact version before showing a short preview and source references. Corrected, deleted or expired versions return no body or provenance through this view. Reads and repeated guards do not create new log entries. Lists use 25-record opaque-cursor pages without exposing a cross-user sequence.

A **conversation snapshot** is evidence of what the Gateway selected for that binding; it is not proof that a Provider received or used every item on every model call. The installed SDK probe checks its first scripted model input separately. Explicit query records describe actual tool execution; duplicate observations reuse their trace, and changed results are retained as new observations. Ordinary memory administration remains read-only. Automatic message extraction, semantic/reasoning retrieval and idle-triggered Dream execution are not completed by this trace feature.

```sh
node --test packages/session-adapter/verification/native-memory-retrieval-runtime.mjs
```

As with the consolidation probe, set `JOT_DSH_RUNTIME_MODULES` to the installed locked rc2 packages. The local scripted model verifies tool wiring and original budget settlement, not real-provider retrieval quality. Runtime query logs and user data are excluded from the public source release.

## Public-source capture and reviewed candidates

The memory toolbar includes **Automatic memory** for the selected role. Its
future-run source policy is off by default. Completed public text can be
collected into source-backed batches; the original DSH workspace tool can
read these batches and propose notes. The owner reviews and applies or rejects
them. A collection receipt is not proof that a model extracted facts.

See [memory automation](MEMORY-AUTOMATION.md) for the API, isolation, BRAIN.md
publication boundary, storage behavior and optional original-pool idle extraction. The
separate installed-SDK canary is:

```sh
node --test packages/session-adapter/verification/native-memory-capture-runtime.mjs
```

It uses a scripted local model, proves original budget settlement and keeps
live memory unchanged until an explicit owner apply. It does not test the
upstream plugin's autonomous extraction or a real model's quality.


## Optional idle extraction engine

The pinned upstream extraction engine is now available through a dedicated original `memory_capture` run, authenticated Host entry and the original worker pool's idle fallback. It produces source-backed candidates without writing live memory or registering a second memory toolset. Role policy remains opt-in. Original ownership, source/task freshness, high reasoning, cumulative budget scopes, background capacity and lease fencing remain enforced. The Host propagates cancellation to the auxiliary stream; known incurred usage can settle after source revocation.

The workbench shows processing or reconciliation state. A committed proposal plus settled original usage can recover a lost response without another model call. Unknown usage or an existing unconfirmed scratch claim does not trigger speculative replay. Deployment-specific crash recovery, real-provider quality and production acceptance are distinct remaining gates. See [configuration and evidence boundaries](MEMORY-AUTOMATION.md).

```sh
node --test packages/session-adapter/verification/native-memory-plugin-runtime.mjs packages/session-adapter/verification/native-memory-idle-runtime.mjs
```

These probes use the actual locked SDK and upstream plugin with a scripted model. The idle probe enters through the original worker-pool function and Gateway/SQLite budget ledger; it does not prove real-provider quality or that an external deployment has enabled the feature.

## Ordinary Goal continuation records

Resume controls now have an internal durable intent/receipt record, a live Host observer/maintenance handshake and a distinct original-Worker/native-Runner continuation entry. No original human message or attachment is replayed. Real locked-SDK cases verify cold resume and original publication with a local scripted model. Public atomic 202 admission and UI integration are connected and verified with the real locked Host/Worker against a scripted local model. Message-free runs preserve original lineage without replaying human input. Exhaustive crash recovery, complete consumer-pool rollout and production acceptance remain unfinished; both rollout switches stay off by default. See [continuation boundaries and verification](docs/GOAL-CONTINUATION.md).


The observed Goal adapter parks official follow at its opening snapshot until
preflight and native maintenance admit restoration. This matters because the
locked official iterator promotes a prepared Session when advanced past that
snapshot. Confirmed pre-native refusals have exact immutable receipts; failures
after invoking native resume remain uncertain. See [Goal failure and crash
boundaries](docs/GOAL-CONTINUATION.md#failure-evidence-and-remaining-crash-matrix).


Ordinary Goal controls now persist minimal owner/conversation-scoped command
metadata before POST, recover the original key after reload or renderer-process
termination, and require explicit retry. Separate command keys preserve uncertain
operations from different tabs; acknowledged tombstones prevent pruning failures
from resurrecting them. Account changes and unavailable browser storage fail
closed. No objective, message or credential is journaled. This is local recovery
evidence; OS/power-loss and production acceptance remain unverified. See
[browser command recovery](docs/GOAL-CONTINUATION.md#browser-command-recovery).


The locked SDK's cold query already presents conservative logical closers for
persisted interrupted tails; its original resolver commits them during resume.
Jot keeps that implementation. Real Host regressions now cover an open tail and
started/unstarted tool requests, read-only log hashes, original-run continuation
and cold restart. Pending/claimed input and still-open attached turns remain
separate unresolved recovery requirements. See [official interrupted-tail recovery](docs/GOAL-CONTINUATION.md#official-interrupted-tail-recovery).


Revoking an ordinary Goal observer now cancels its same-Goal in-flight work with
the SDK's `keepInbox` option, preserving later queued and steering inputs.
Paused/blocked/complete phases do not hide a still-running closing request;
replacement Goals remain untouched. A real Host disconnect/flush/restart probe
checks retained input IDs and no extra inference. This does not complete original
pending-input delivery recovery. See [observer revocation](docs/GOAL-CONTINUATION.md#observer-revocation-preserves-other-inputs).


Whole-browser termination exposed a limitation of the former localStorage
journal: same-page read-back did not ensure the command survived process exit.
Ordinary Goal controls now await strict IndexedDB transaction completion before
POST and acknowledgement. The owned-browser process-tree/restart probe passes
with the same profile and exact original request, alongside renderer recovery,
legacy migration and storage-failure tests. OS/power loss and production acceptance
remain unverified. See [browser recovery](docs/GOAL-CONTINUATION.md#browser-command-recovery).


Observer revocation also preserves original human inputs already claimed by the
current live pre-step, before any conversation-message commit. It quietly retains
that unentered step context using the official next-step convention, preserving
IDs/content/source without a new prompt or wake. User cancellation is respected;
conflicting or already committed input is not overwritten/replayed. The real Host
lease-revocation/flush/restart probe makes zero model requests. Cold reconstruction
and original-run execution recovery remain separate. See [live claimed inputs](docs/GOAL-CONTINUATION.md#live-claimed-input-preservation).


## Native Goal pre-flush process boundary

The real installed-SDK probe now terminates its owned isolated Host at the
synchronous native resume notification, after its in-memory change and before
the adapter can confirm its flush. Cold restart retains the original revision
in this case, while the original Gateway dispatch remains uncertain rather than
being relabelled not-called. There is no inference, answer publication, replacement
command or automatic reactivation. This extends process-death evidence to three
specific boundaries; partial storage writes, original pending-input execution,
provider settlement, publication and production acceptance remain separate gates.
See [Goal continuation](docs/GOAL-CONTINUATION.md) for the exact boundary and limits.


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
See [Goal continuation](docs/GOAL-CONTINUATION.md).


## Ordinary claimed-input policy milestone

An unpublished native-factory policy now verifies the original Gateway owner,
run, input hash and lease, plus historical per-message admission and composition
fingerprints, before restoring an unentered claimed human message. Real process
termination/recovery verifies durable original-input restoration once and rejects
wrong lease/profile/admission without model calls. This does not enable ordinary
HTTP claimed recovery: original Controller admission storage, factory composition,
Host/Worker integration and production acceptance remain open. See
[Goal continuation](docs/GOAL-CONTINUATION.md).


## Original prompt admission milestone

An optional Host now records hash-only private receipts from the actual
Controller's final native input and gates model entry on durable admission.
First-generation opted-in Worker/Runner/Client metadata carries only the original
run and lease. Real Controller probes verify claim-gap deduplication, one normal
model execution and one canonical Worker answer, without duplicate execution on
retry/restart. The original attachment pipeline is preserved; these native cases
use text. Cold claimed-factory integration, richer attachment acceptance, cost
settlement, retention and rollout remain separate unfinished gates. See
[Goal continuation](docs/GOAL-CONTINUATION.md).


## Ordinary entry reservation milestone

Versioned original admission receipts now require an exclusive durable native
step-entry reservation. A competing or previously reserved attempt cannot be
replayed from an apparently unentered cold log. Original pending-input recovery
must adopt the real admission gate before wake; legacy identity-only Host
configuration is refused. The entry record is neither a model-call receipt nor
usage/accounting evidence. A real Host hard-exit probe preserves that conservative
boundary. Cold claimed-factory integration and unknown outcome/cost reconciliation
remain open; no production switch is enabled. See
[Goal continuation](docs/GOAL-CONTINUATION.md).
