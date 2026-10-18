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

- [ ] Add contract tests for explicit Chat/Work creation, existing Work migration, capability-gated UI defaults, unknown fields, owner/version rejection and active/unknown native Goal conflicts.
- [ ] Persist current conversation mode and immutable per-run policy plus exact native Session binding. Backfill original Work bindings without recreating native Sessions or Goals.
- [ ] Update all original input/steering/history/final/Goal consumers to resolve per-run identity; tests must catch a switch trying to recover an earlier run through the new mode's pointer.
- [ ] Refuse unavailable Chat configuration before acceptance. Preserve pending-message idempotency; a retry cannot change mode, model, context or attachments.

## 4. Implement the Chat preset and bounded context

Files: a separate declaration in `packages/dsh-host/`, focused modules in `packages/session-adapter/`, actual SDK verification scripts, native policy fixtures.

- [ ] Test fixed Chat route, thinking disabled, official Search/Fetch discovery and no arbitrary writes or browser mutation tools.
- [ ] Implement the exact bounded ordered seed in the spec, retaining original message/source/version identities. Keep full Work history stored and never fork it wholesale into Chat.
- [ ] Persist one parallel search allowance and one parallel fetch allowance per native turn, including interrupted/uncertain operations. Test steering/restart cannot reset consumption.
- [ ] Implement post-answer-only native compaction, cancellation on new input, no second answer and complete background usage. Work compaction remains visible.
- [ ] Verify stable request prefixes and actual provider cache metrics when configured. Do not send periodic model probes or fabricate hit counters.

## 5. Connect the UI and standalone profile

Files: `web/jot/RoleConversation.tsx`, `PromptComposer.tsx`, `client.ts`, `types.ts`, owned mutation receipt/controller tests; separately `src/server.mjs`, `src/model.mjs`, standalone schemas and API tests.

- [ ] Show one clickable Chat/Work label; hide model/effort controls in Chat. Use the existing immutable retry and versioned mutation flow; preserve mobile pointer/focus, keyboard, uploads and voice behavior.
- [ ] New UI conversations request Chat only when the returned readiness supports it; display actual unavailable state otherwise. Keep older clients compatible.
- [ ] Expose the same explicit behavior in the standalone profile through its own tested protocol. Do not proxy it silently to an extended host or label synthetic demo output as a live answer.
- [ ] Test accepted and unconfirmed sends, cancellation, steering, attachments, reload and mode switches through actual local React/API/SDK boundaries.

## 6. Release gates

- [ ] Run root tests/build, full Gateway tests/build, changed adapter/host suites and actual installed-SDK cases. Record skips and external-provider prerequisites separately.
- [ ] With operator-supplied credentials, compare repeated short knowledge questions and search questions using actual usage, preparation, first-token and final-answer timings. Never publish raw conversations, credentials or deployment identities.
- [ ] Update feature/deployment/Agent documentation with supported profiles and exact remaining limitations.
- [ ] Review the complete staged diff, runtime exclusions, reachable history and binary templates. Commit only explicit reviewed paths; push the feature branch and verify its exact remote hash.

No unchecked step in this plan is completed by publishing this document. The full 26-capability ledger remains in [the parent plan](2026-10-17-pilotdeck-remaining-full-chain.md).
