# Git workbench implementation plan

> Execute with the existing plan-execution workflow, without subagents, as requested. Keep the full capability ledger open until every remaining Git phase is verified.

**Goal:** implement the approved Git capability through the existing owned project and Gateway contracts, from repository inspection to reviewed local and separately authorized remote operations.

**Architecture:** DSH remains the sole planner. The Gateway binds an operator-configured repository to an existing owner/project. Read-only snapshots never authorize execution. Later mutations use the existing approval, version, atomic-command and immutable-receipt conventions; no second planner or general shell endpoint is introduced.

**Tech stack:** Node child-process argument arrays and bounded streams, existing Fastify/Ajv contracts, existing ProjectRepository, React workbench and same-origin BFF.

**Spec:** [full remaining product chain, capability 15](../../implementation/2026-10-17-remaining-product-release-chains.md#15-git-workbench), [full 26-capability ledger](2026-10-17-pilotdeck-remaining-full-chain.md).

## Constraints

- Windows local builds; all generated files under the existing project/workspace. No production activation or credential changes.
- Operator-only absolute repository roots; callers cannot supply a root, executable, arbitrary ref, pathspec or Git argument. Validate project ownership before touching the repository and recheck after awaited work.
- Pin physical worktree/Git/common-directory identities. Reject replacement, symlinks, unsafe metadata and changed snapshot witnesses. Linked worktrees require explicit trusted metadata directories, not a caller-supplied `.git` target.
- Fixed resolved Git executable outside the inspected repository; argument-array spawn, no shell, minimal child environment, no optional locks, pager, external diff/text conversion, fsmonitor, lazy fetching or interactive credentials. Git reads a disposable metadata copy with the original HEAD/index/refs and controlled object directory; only allowlisted nonexecutable configuration is copied. Source includes, hooks, clean/process filters and credentials are never activated. Source metadata is reverified before/after. Errors do not echo stderr, host paths or raw remote URLs.
- Bound output, time, changed paths and metadata scanning; cancellation kills only the owned subprocess. Remote projection omits credentials, queries and remote paths. Private workspace paths cannot be previewed as diffs.
- Unborn/detached/conflicted/renamed/deleted/untracked/binary states must be explicit. A status/diff view is not a write approval.
- Preserve all original Session, Goal, task, accounting, lease and tool-permission contracts. Standalone local runtime and extended Gateway remain distinct.

## Task 1: owned read-only repository service

- [x] Write failing actual-local-Git tests in `packages/gateway/test/git/inspection.test.mjs` covering repository states, exact snapshot changes, root/metadata replacement, symlinks, shell/pathspec injection, malicious local diff/fsmonitor configuration, remote credential redaction, cancellation and bounded output.
- [x] Implement `packages/gateway/src/git/process.ts` for trusted executable resolution and fixed read-only process dispatch; `inspection.ts` for trusted physical binding, status snapshots and exact selected-file diffs. No database writes or external network calls.
- [x] Check the original repository/index bytes remain unchanged by inspection. Require a matching snapshot for patch reads; changed file contents with the same porcelain status must invalidate it.

## Task 2: project API and shared contract

- [x] Add an owner/project-bound `git/service.ts` and `git/routes.ts`. Configure an explicit trusted mapping, default empty; list only owned configured project IDs in capabilities.
- [x] Expose GET `/v1/projects/{projectId}/git` and GET `/v1/projects/{projectId}/git/diff` with bounded path, snapshot and staged/working selection. Return fixed error codes and metadata-only repository identities. No mutation routes in this phase.
- [x] Synchronize OpenAPI JSON/YAML, operation manifest and types. Existing BFF project forwarding remains in force; do not accept owner/path-root overrides.
- [x] Test foreign/deleted projects, query injection, unconfigured roots, stale snapshots, failed reads and API schemas through the actual Gateway/BFF.

## Task 3: full read-only workbench workflow

- [x] Add a Git workbench view that selects an owned configured project, displays branch/HEAD/status and bounded staged/working patches, and refreshes after a conflict. Binary/unsafe/unavailable states are clear.
- [x] Reuse `useResource` cancellation/identity rules; a late response from a different project or selection must never appear in the current view.
- [x] Exercise the real mobile React/BFF/Gateway UI with a temporary local repository. Verify source edits invalidate a prior snapshot and no commit/discard/push is inferred from a view.
- [x] Run appropriate targeted and complete root/UI/Gateway tests and Windows builds, source/staged/history privacy review, then publish a scoped reviewed increment. Keep the full Git capability open.

## Task 4: reviewed local mutations

Internal prerequisite implemented, not API/UI execution readiness: the
[exact-review journal](../../implementation/2026-10-19-git-review-intents.md)
freezes source-byte/index/HEAD witnesses and stores original approval/cancellation
acknowledgements. Nine new intent cases and all 29 Git cases pass. The tasks
below remain open until the original authenticated command path, user controls,
actual writes and crash recovery are connected and accepted.

The subsequent [review API increment](../../implementation/2026-10-19-git-review-api.md)
connects owner/CSRF checks and the original atomic HTTP receipt, with explicit
rollback/restart/replay tests. No write capability follows from approval alone.
The [review workbench](../../implementation/2026-10-19-git-review-ui.md) now joins
the actual mobile React/BFF/API path for all five review types, exact current-page
request recovery and current-state reconciliation after another device cancels.
Full UI250/root67 and API Gateway1952pass7skip are separate executed gates.
Actual local effects, original execution authority, immutable outcome publication
and crash recovery remain open in the tasks below.

The [internal stage/unstage kernel](../../implementation/2026-10-19-git-index-effects.md)
now calculates and publishes exact selected index bytes under original Git
locks and final authority/source fences. Its tests use real local repositories,
including lost acknowledgement and outside matching-byte interference. It is
not mounted in the API/UI and does not provide durable cross-process recovery;
none of the full mutation checkboxes below is closed by this prerequisite.

The [internal durable execution increment](../../implementation/2026-10-19-git-durable-index-execution.md)
now binds original approval protocol 2, immutable request/dispatch/outcome rows
and the existing Worker lease to actual selected effects. New-process fixtures
recover original publication without replay and release proven owned locks.
The [detailed continuation plan](2026-10-19-git-durable-index-execution.md) keeps
explicit not-published disposition and original API/UI execution admission open;
these are required before closing task 4. Partial lock acquisition now commits
owned-file identities before exclusive placement and has actual process-exit
coverage through the link/unlink gaps. Cleanup does not close the full task.

The [internal disposition increment](../../implementation/2026-10-19-git-execution-disposition.md)
now adds stable configured exclusion, original owner acknowledgements and fenced
cleanup. Its complete release gates and original API/UI admission remain open;
this does not close commit/destructive/revert or the full task 4 requirements.

- [ ] Freeze repository identity, HEAD, index and selected worktree bytes in an original owner-approved intent; separate stage/unstage, commit and destructive discard/revert/untracked-delete operations.
- [ ] Revalidate original authority and all witnesses before dispatch and receipt publication. A stale review never applies to changed bytes. Preserve exact original request on unknown response.
- [ ] Recover original effects from Git object/index/worktree evidence without replaying an unknown mutation. Test crash boundaries, conflicts, concurrent processes and cancellation.

## Task 5: separately authorized remote operations

- [ ] Use credential references, fixed remote identities and explicit per-operation approval for fetch/pull/push/publish. Never return credential bodies or enable a generic Git command.
- [ ] Freeze selected branch/ref/remote and local state, retain exact result/unknown outcome, and reconcile remote facts before any retry. Never force-push or resolve conflicts implicitly.
- [ ] Validate actual permitted remote operations with the operator's explicit authorization after local/provider/credential readiness; record these separately from local fixtures.

## Release scope

Read-only completion is a prerequisite, not completion of capability 15 or the full PilotDeck plan. Local mutation, remote recovery, packaging and the remaining 25 capabilities retain their own evidence requirements. No broad production readiness claim follows from a local Git test.
