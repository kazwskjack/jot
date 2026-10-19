# Portable Chat and Work Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task by task. Do not use subagents unless the user changes the current restriction. Preserve the original public adapter; do not copy application-specific runtime files over it.

**Goal:** deliver the requested fast Chat and existing Work modes through the original public conversation, Gateway and native DSH contracts, then publish tested code without private deployment data.

**Architecture:** Gateway freezes owned input/run policy and native identity; DSH executes the selected mode. Existing admission, recovery, permissions, Goal controls and delivery remain authoritative.

**Tech Stack:** TypeScript, Node SQLite, React, the installed official DSH SDK and its Search/Fetch facilities. No second planner or replacement job scheduler.

**Spec:** [portable execution design](../specs/2026-10-18-portable-chat-work-design.md).

## 1. Close existing model mutation boundary

- [x] Reproduce a queued accepted message allowing a model PATCH with HTTP 200.
- [x] Add an API regression for every nonterminal state, unchanged model/version on denial, metadata edits, owner isolation and stale versions.
- [x] Include queued execution in `src/conversations/repository.ts` and perform validation/write through the existing immediate transaction helper.
- [x] Run the four focused conversation/metadata suites: seven tests passed.
- [x] Complete Gateway regression: 1,730 tests, 1,723 passed, seven skipped, zero failed. A later additional receipt-replay assertion was included in the final eight-test focused rerun; the two overlapping runs are not added together. Both Gateway and root builds passed; the root suite passed 50 tests.

## 2. Prove and complete native model policy consumption

Files: `packages/gateway/src/harness/worker.ts`, `official-session-runner.ts`, `session-controller-client.ts`; `packages/session-adapter/index.js`, original input/recovery modules and `budget-model-selection.js`; corresponding harness, adapter and installed-SDK tests.

- [x] Forward cancellation to the existing budgeted host model resolver. The installed official `LlmRuntime` cancellation probe passed with a local scripted capability resolver, without inference or Session selection. This is a prerequisite, not ordinary conversation model integration.
- [x] Add a failing installed-SDK test that sets an ordinary conversation's approved model/effort and observes the actual next native request. Database persistence alone must not pass.
- [x] Replace the hard-coded empty capabilities catalog with an authenticated, detached host metadata projection; test owner isolation, cancellation, supported effort identifiers and absence of keys/private endpoints. The official catalog is advisory: operator-permitted unlisted models still require exact provider resolution, not an invented catalog-membership rule.
- [x] Trace first admission, steering, warm reuse, cold replay and original final publication. Identify every reader currently relying on a mutable conversation Session pointer.
- [x] Freeze server-validated model policy on the original accepted run and carry an authenticated revision/hash reference through original host admission. Browser-supplied host policy is rejected.
- [x] Use official resolution/selection APIs to apply that exact model and supported effort before the original input executes; refuse identity drift. Preserve separately configured budgeted role selection. Chat's separate thinking-disabled policy remains in task 4.
- [x] Verify cancellation, unsupported providers, forged policy, lost receipts and cold recovery without creating a replacement native input.

Evidence: [original-run model policy](../../implementation/2026-10-18-native-model-policy.md). The installed SDK's four ordinary cases, one hard-exit recovery case and one resolver-cancellation case passed using local scripted providers. Gateway: 1,734 passed / seven skipped; adapter: 578 passed / 25 skipped; root: 50 passed; Gateway and root builds passed. Generated profiles remain default-off; live provider and deployed preset acceptance remain pending.

## 3. Add mode-aware acceptance and Session identity

Files: Gateway database migration, conversation repository, run admission, contracts in `packages/gateway/contracts/`, original binding/history/control modules, native host adapter, `web/jot/types.ts` and client types.

Implemented prerequisite: [original-run Session binding](../../implementation/2026-10-18-original-run-session-binding.md).
Acceptance freezes an existing owned destination; the first Worker pins an
unallocated one under its live lease. Execution, recovery, cancellation,
ordinary history/final delivery and accepted Goal controls use that original
binding. Installed-SDK tests include pointer movement and abrupt Host exit.
Backend acceptance is now implemented in [mode admission and native identity](../../implementation/2026-10-18-conversation-mode-admission.md).
The live Chat preset, UI default and standalone profile remain open.

- [x] Add backend contract tests for explicit Chat/Work creation, Work migration, unknown fields, owner/version rejection, active/unknown native Goal conflicts and readiness metadata. Capability-gated UI defaults remain in task 5.
- [x] Persist current conversation mode and immutable per-run policy plus exact native Session binding. Backfill original Work bindings without recreating native Sessions or Goals.
- [x] Keep original input/steering/history/final consumers on per-run identity and new Goal controls on the saved Work mapping; verify real Work history after a mode switch. Role/native child and mailbox authority remain separate and unchanged.
- [x] Refuse unavailable Chat configuration before acceptance. Preserve atomic input/mode receipts and original message retries; test outage after a lost response and no duplicate run. No new attachment/context execution is claimed before task 4.

## 4. Implement the Chat preset and bounded context

Files: a separate declaration in `packages/dsh-host/`, focused modules in `packages/session-adapter/`, actual SDK verification scripts, native policy fixtures.

- [x] Test fixed Chat route, thinking disabled, official Search/Fetch discovery and no arbitrary writes or browser mutation tools. The actual official Host sends `thinking: disabled` and exactly two Web schemas through original Gateway/Worker admission; [native preset evidence and remaining scope](../../implementation/2026-10-18-native-chat-preset.md). Readiness stays unavailable until the remaining items below are implemented.
- [x] Implement the exact bounded ordered seed in the spec, retaining original message/source/version identities. Keep full Work history stored and never fork it wholesale into Chat. [Acceptance, native surface integration and evidence](../../implementation/2026-10-18-chat-context-window.md). Real readiness stays off pending the remaining task 4 gates.
- [x] Persist one parallel search allowance and one parallel fetch allowance per native turn, including interrupted/uncertain operations. Test steering/restart cannot reset consumption. [Original-run ledger, actual supplemental input, provider receipts and SDK reopen evidence](../../implementation/2026-10-18-chat-web-allowances.md). Separate newly accepted questions receive new allowances; supplements do not.
- [ ] Implement post-answer-only native compaction, cancellation on new input, no second answer and complete background usage. Work compaction remains visible.
- [ ] Verify stable request prefixes and actual provider cache metrics when configured. Do not send periodic model probes or fabricate hit counters.

### Background compaction sequence within task 4

Keep this sequence under the original Gateway authority and original DSH
Session. The intent journal below is provenance, not another planner or task
scheduler. Completing its first step does not complete background compaction.

1. **Completed-source prerequisite:** implemented in
   [source and immutable-intent evidence](../../implementation/2026-10-18-chat-compaction-source.md).
   Require the original completed canonical answer/publication, policy,
   resolved model, bounded-context digest, owner and native Session. Refuse
   live foreground authority, unapplied supplements, newer inputs, changed
   sources and Work scopes. A valid historical publication may retain the
   original interrupted run status. Inspect/prepare/read never grant execution.
2. **Native need/idle check:** in a focused Session-adapter module, confirm the
   actual owned native completion and idle/empty-inbox state. Use the pinned
   official token meter, routed-model metadata and effective context pressure;
   do not measure the raw stored transcript as if it were the next request.
   Low pressure, missing reliable metadata or a busy Session means a quiet
   no-op, not a forced summary or foreground retry.
   Partial prerequisite implemented: [effective-pressure evidence](../../implementation/2026-10-18-chat-compaction-pressure.md).
   `chat-compaction-pressure.js` reads the
   official effective meter and exact routed capacity, snapshots the request
   envelope/surface measurement around metadata resolution and quietly refuses
   missing or changing facts. Threshold includes effective output reservation
   and headroom, matching the pinned SDK calculation. Thirteen focused tests
   cover low/equal pressure, route drift, missing capacity, raw-history
   exclusion and cancellation. This is unwired advice only, not native
   completion/idle proof, SDK execution acceptance or independent admission.
   The subsequent [native observation composition](../../implementation/2026-10-18-chat-maintenance-observation.md)
   now joins the original completed source, shared native completion parser,
   exact canonical answer verification and actual effective meter. The actual
   official Host verifies two completed questions, low-pressure skips and no
   extra model call/answer/database write. It waits for native `whenIdle()`
   rather than treating the SDK's maintenance `status: idle` as a reservation.
   Original cold-history recovery retains its registry-empty contract.
   This completes the observational prerequisite only: independent dispatch,
   official inference/accounting, checkpoint consumption and readiness remain
   open. Any future dispatch must recheck source under its own maintenance
   boundary; these observations are not reusable grants.
3. **Dispatch/accounting boundary:** record a separately fenced background
   attempt before inference. Bind it to the immutable intent and original
   source. Never reuse the completed foreground execution lease, create a
   replacement conversation/run, or grant a model from browser parameters.
   Verify the exact resolved provider/model and Chat's thinking-disabled
   policy on the actual auxiliary request. The SDK's default summarization
   call uses `purpose: compaction` but does not automatically copy Chat's
   reasoning effort. Do not mutate frozen request options to fix that.
   Implemented prerequisite: [independent call journal and stream accounting](../../implementation/2026-10-18-chat-compaction-accounting.md).
   One immutable intent/attempt binds original scope, Host observer/fence,
   native witness and exact thinking-off compaction call. Only a first durable
   dispatch transition lets the separate native guard advance. New input and
   ticket expiry revoke dispatch; frozen original identity still accepts late
   actual usage. Unknown/partial tokens and unpriced cost are never zeroed.
   The real official SDK probe uses `runMaintenance` and an explicit auxiliary
   call: three requests total, two canonical answers, eleven auxiliary tokens,
   no native log change or checkpoint. It does not compose the compaction
   engine or enable automatic execution/readiness.
4. **Official execution and cancellation:** compose the original compaction
   engine for Chat with automatic foreground compaction disabled; preserve
   Work's composition. Only after the pressure and independent admission
   checks, call official idle maintenance (`compactNow`/`runMaintenance`).
   New input cancels the background operation's own signal and drains that
   maintenance boundary before the original native input enters. Do not cancel
   another foreground task or infer permission from a stale "current run".
   Capture dispatched/partial/unknown usage even after cancellation; a lost
   receipt is observation/recovery work, not permission for another inference.
   Implemented explicit prerequisite: [original native engine and input cancellation](../../implementation/2026-10-18-chat-native-compaction.md).
   Actual SDK tests verify high-pressure summary/settlement, low-pressure skip,
   and a new original question cancelling/draining a live auxiliary stream.
   The inherited official engine supplies native markers, replacement, flush
   and replay. The manager resolves isolated services through official
   `serviceFor`, preserving stable implementation identity across Cordis proxies.
   That increment supplied explicit execution only. The useful checkpoint,
   Host-exit recovery and automatic-start follow-ups are recorded below; default
   readiness and production activation remain off.
5. **Useful checkpoint handoff:** retain the official summary event, source
   span/generation and hashes as an owner-scoped checkpoint. Verify its source
   again before publication. A subsequent Chat acceptance may use a verified
   checkpoint plus recent text within the existing total bound; version the
   context algorithm/revision explicitly. Do not invent a canonical human or
   assistant message, discard original history, or summarize content that the
   next seed will simply throw away. New-input/source conflicts suppress the
   checkpoint without erasing incurred usage.
   Execution detail for the checkpoint handoff:
   - Add an empty immutable owner/Session checkpoint journal, one record per
     settled original auxiliary attempt. Keep native summary/span/generation
     hashes and bounded text, original source and parent checkpoint identity.
     No legacy backfill, canonical message or new user-facing event.
   - The Host validates the unchanged raw prefix and exact official standalone
     start/summary/adjacent replacement/end result, selected original input and
     accepted context marker, exact retained-answer coverage, durable flush and surface generation.
     Send bounded authenticated evidence, never the full native transcript.
   - Publish only against the still-current completed source and settled call.
     Exact persisted retries may return the same immutable receipt; late new
     publication after another input is rejected without erasing usage.
   - Opt in through context revision/algorithm `checkpoint-text-v2`. Freeze a
     verified checkpoint plus recent text at original acceptance. Preserve v1
     for existing clients. Exclude covered text only when its exact content hash
     and revision still match; changed text re-enters the recent window.
     Parent references retain older coverage without copying all prior records.
   - The native selector validates the new schema, hashes and framing before
     replacing its conversation body. Preserve the original system/tool prefix,
     actual current input, immutable retry and full stored history.
   - Prove publish/consumption, foreign and stale refusal, duplicate/reopen,
     source drift, cancelled-stream suppression, bounds and actual next native
     request use. Automatic starts/readiness stay off until the remaining gates.
   Implemented: [verified native checkpoint handoff](../../implementation/2026-10-18-chat-checkpoint-handoff.md).
   The opt-in v2 acceptance/native path freezes and consumes exact summaries,
   actual selected coverage and parent lineage. Actual SDK tests carry two
   checkpoint generations into subsequent original requests without duplicate
   summaries or answers; cancellation publishes no stale checkpoint. Disk
   reopen and immutable retry are covered. Host-exit recovery and automatic
   starts have follow-ups below. Presentation and real-provider gates remain
   open; the enclosing post-answer-compaction checkbox is not yet complete.
   The [native surface-order correction](../../implementation/2026-10-19-chat-native-surface-order.md)
   additionally verifies protocol-2 positional coverage after a real official
   context replacement, including hidden historical markers and retained
   answers. Existing protocol-1 records remain compatible. Host-exit recovery
   and automatic post-answer dispatch retain the original authority gates in
   their later implementations below.
6. **End-to-end gate:** actual SDK/Host tests must show no foreground summary,
   a pressure-driven post-answer summary, exactly one user-facing answer,
   correct thinking/provider identity, new-input cancellation, stable retry/
   restart accounting and use of the exact checkpoint in the next native
   request. UI tests must hide only Chat's background activity and preserve
   Work's visible official compaction. Keep real readiness off until these
   execution, accounting and presentation gates pass.

### Host-exit publication recovery before automatic starts

The following recovery sequence is implemented in the opt-in
[original Host-exit recovery](../../implementation/2026-10-19-chat-host-exit-recovery.md).
Automatic starts remain pending. Recovery consumes the original result; it is
never permission to repeat a model call.

- Add an exact bearer-only inspection of the original attempt by owned
  intent/run/Session/version, plus an exact historical checkpoint read. Return
  original binding and receipt metadata only; never allocate an attempt,
  dispatch, extend its fence or expose a browser-selectable scope. An existing
  published receipt remains historical even after another input.
- When no checkpoint exists, inspect the cold original native log without
  registering or waking an Agent/Session. Require the unchanged original raw
  prefix hash/count, and exactly its successful standalone four-event tail.
  Reconstruct the prefix with the official Session API and reuse original
  admission/history/invariant proof logic; do not invent native input IDs from
  a summary or bypass the registry-empty cold-reader boundary.
- Derive the exact native result from its stored summary/replacement/end,
  including positional coverage, generation, model and usage. Reuse the live
  evidence validator. Read the complete cold log again and recheck original
  source/ownership before returning evidence. Partial, ambiguous, changed,
  error-ended or subsequently active logs cannot publish a new checkpoint.
- Complete known native usage through the original immutable attempt journal
  if its settlement reply was lost. Unknown or absent usage remains unknown;
  reserved/released state cannot imply inference. Do not repeat dispatch or
  zero/refund usage. Then call original checkpoint publication, which still
  performs its current-source check; exact committed reads do not renew it.
- Add actual process-exit tests after native durability but before publication,
  after committed publication but before acknowledgement, and during partial
  summary/unknown usage. Restart must recover the original receipt/next seed
  without another summary or answer. Add newer-input, foreign, modified prefix,
  active registry, changed model/usage and repeated-recovery refusals. Keep
  automatic starts off until these and the original presentation gates pass.

## 5. Connect the UI and standalone profile

### Automatic post-answer start implementation sequence

Complete this sequence before enabling general Chat readiness:

The opt-in execution is implemented in
[automatic post-answer maintenance](../../implementation/2026-10-19-chat-automatic-post-answer.md).
Its original Worker/Host tests are separate from UI and real-provider readiness.

1. Add a Host-local post-answer notification handler. An exact original scope
   is accepted on the authenticated internal adapter channel only. Coalesce an
   in-flight duplicate for that same scope; do not reuse a different run's job.
   A notification is not a foreground lease or permission to change a model.
2. In the detached background operation, prepare the existing immutable source
   intent and inspect its original attempt. A prior attempt goes through the
   already implemented receipt/result recovery, never a fresh manager dispatch.
   A fresh attempt requires the same live original Chat Agent and its official
   idle boundary, then delegates to the existing compaction manager. The manager
   keeps all native admission, pressure, model, source and usage checks.
3. Add an exact bearer-only `chat-post-answer` adapter entry and matching trusted
   Session client method. It acknowledges only notification acceptance, without
   waiting for inference or exposing this entry to model/browser tools. Its
   job has its own lifetime signal; a closed notification HTTP request cannot
   cancel an already accepted job. Shutdown aborts and drains owned jobs.
4. Notify only after the original Worker has committed a canonical Chat answer
   and finalized that original run. Read the resulting original owner, Session,
   policy and version from trusted rows. Do not notify Work, unfinished, failed
   or superseded answers; do not carry the foreground execution lease. This is
   best-effort background maintenance, not a new persistent job queue or task
   scheduler. Lost delivery may skip the optimization; it cannot repeat a model
   call. Original intent/attempt recovery governs any explicit exact retry.
5. Keep admission's existing manager cancellation/drain hook. Verify both a new
   input arriving before the manager starts and one arriving during its model
   stream. Neither path may publish a stale checkpoint or delay the next input
   behind a non-owned foreground cancellation.
6. Wire independent opt-in switches with strict prerequisite checks and default
   off. Add unit/transport and original Worker tests, then actual SDK cases
   showing automatic low-pressure skip, high-pressure useful summary, immutable
   retry, next-request consumption and cancellation. A request file or manual
   probe is not automatic-start acceptance. Keep UI/provider gates separate.

Files: `web/jot/RoleConversation.tsx`, `PromptComposer.tsx`, `client.ts`, `types.ts`, owned mutation receipt/controller tests; separately `src/server.mjs`, `src/provider.mjs`, standalone schemas and API tests.

- [x] Show one clickable Chat/Work label; hide model/effort controls in Chat. Use the existing immutable retry and versioned mutation flow; preserve mobile pointer/focus, keyboard, uploads and voice behavior. See [UI implementation and limits](../../implementation/2026-10-19-chat-work-ui.md).
- [x] New UI conversations request Chat only when the returned readiness supports it; display actual unavailable state otherwise. Keep older clients compatible.
- [ ] Expose the same explicit behavior in the standalone profile through its own tested protocol. Do not proxy it silently to an extended host or label synthetic demo output as a live answer.
  The [standalone sequence](2026-10-19-standalone-chat-work.md) records its mode
  persistence/acceptance prerequisite and the remaining executor/UI work.
- [ ] Test accepted and unconfirmed sends, cancellation, steering, attachments, reload and mode switches through actual local React/API/SDK boundaries.

### Native Work compaction presentation sequence

Implementation and distinct native/synthetic acceptance are recorded in
[Work compaction activity](../../implementation/2026-10-19-work-native-compaction-ui.md).
Final full regression and release checks remain separate gates.


At the initial inspection, `session-event-projector.ts` dropped native
compaction events and `RoleConversation.tsx` did not render activities. The
linked Work compaction increment now supplies the opt-in projection and UI;
general activation and the broader acceptance gates remain separate.
The pinned official event contract supplies `compaction/start` and
`compaction/end` with one `compactionId`; its `compaction/summary` includes
summary/model/raw-output fields that must not become public chat content.

1. Add an explicit compaction activity contract and synchronize the checked-in
   schema, OpenAPI and UI type consumers. Keep new producer output opt-in until
   the paired consumer supports that activity kind; never disguise it as a
   command, file edit or assistant reply.
2. Derive Work/Chat visibility from the original accepted immutable policy in
   the Runner, not browser input or current mutable conversation settings.
   Only Work projects start/end metadata. Chat background maintenance stays
   absent from the public message and activity stream.
3. Bind one activity to the original run and native compaction ID, carrying
   bounded phase/status/times only. Do not project native summary, raw output,
   error text, model identifiers or another authorization token. An end event
   without a matching observed start must not manufacture successful progress.
4. Verify real Runner/event-store/snapshot/UI transitions: start, success,
   native error, cancellation, duplicate replay and reconnect. A missing end
   is unknown or interrupted when the original run ends, never inferred success.
   Preserve existing tool activity and answer rendering.
5. Exercise the installed SDK boundary with an actual native event sequence,
   and separately verify quiet Chat behavior. Static rendering or a helper-only
   fixture cannot close the complete producer-to-consumer acceptance gate.

## 6. Release gates

- [ ] Run root tests/build, full Gateway tests/build, changed adapter/host suites and actual installed-SDK cases. Record skips and external-provider prerequisites separately.
- [ ] With operator-supplied credentials, compare repeated short knowledge questions and search questions using actual usage, preparation, first-token and final-answer timings. Never publish raw conversations, credentials or deployment identities.
- [ ] Update feature/deployment/Agent documentation with supported profiles and exact remaining limitations.
- [ ] Review the complete staged diff, runtime exclusions, reachable history and binary templates. Commit only explicit reviewed paths; push the feature branch and verify its exact remote hash.

No unchecked step in this plan is completed by publishing this document. The full 26-capability ledger remains in [the parent plan](2026-10-17-pilotdeck-remaining-full-chain.md).
