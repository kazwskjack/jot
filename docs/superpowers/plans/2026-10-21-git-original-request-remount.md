# Original Git request remount recovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans task-by-task. Follow the user's single-agent restriction; do not spawn agents.

**Goal:** Preserve an original unconfirmed Git review/admission/control body and transport key across reload, including before server commit, without automatically executing anything.

**Architecture:** Extend the existing TaskSaveReceipt optional-store mechanism with an owner/project-scoped, untrusted browser recovery hint. Keep original authenticated endpoints and immutable server receipts authoritative. Native dispatch/resolve are not persisted or automatically retried.

**Tech Stack:** React, existing request client and TaskSaveReceipt, browser storage, Node tests and actual local Playwright/BFF/Gateway acceptance.

**Spec:** Original pending-request/remount requirement in `2026-10-19-git-index-http-workflow.md`; original selected Apply behavior in `2026-10-21-index-native-apply-and-recovery.md`.

## Global constraints

- DSH remains the planner; no new server registry, receipt store or scheduler.
- Original current owner, CSRF, review, versions, request IDs and state digests remain mandatory.
- A local record is not approval or evidence of server acceptance. Never auto-POST during mount, storage events or refresh.
- Do not store credentials, cookies, file contents or native dispatch/resolve requests.
- Keep unknown request metadata on network/408/5xx/in-progress results. Clear it only after the existing receipt mechanism confirms a response or known rejection.
- Storage failure prevents a new untracked request. A different current owner or project cannot restore another namespace.
- Use synthetic files/local services; no production deployment, real models or user data.

## Task 1: Original command persistence adapter

**Files:** create `web/workbench/git-command-draft.mjs` and `git-command-draft.test.mjs`.

**Interfaces:**

```js
new GitCommandDraftStore(storageOrGetter, ownerScope, project, restoredKey?)
store.read() // null or {command:{path,method,body,key}}
store.saveCommand(commandOrNull)
store.complete()
listGitCommandDrafts(storageOrGetter, ownerScope, project)
// [{key,kind,intent_id?,execution_id?,command}], all strictly validated
```

- [x] Write and run failing tests with Map-backed storage and real TaskSaveReceipt. Send a request that rejects without a known status, recreate both store and receipt, and prove an explicit retry uses the original body/key despite different caller arguments.
- [x] Validate the exact allowlisted review prepare/control, index admission and index control routes and body fields. Reject native dispatch/resolve, arbitrary URLs, extra keys, cross-scope records and malformed JSON before any request.
- [x] Use one storage key per transport key under the original authenticated owner namespace and encoded project. A new request cannot overwrite another request's record. Rewriting the same key requires byte-identical canonical data.
- [x] Test quota/read failure, two pending records, immutable caller data, known400/409 clearing, unknown408/5xx retention, and exact source-state digest retention.

Example acceptance:

```js
const store = new GitCommandDraftStore(storage, scope, 'project');
const receipt = new TaskSaveReceipt(() => 'original-key', store);
await assert.rejects(receipt.submit(async () => { throw Error('offline'); },
  '/projects/project/git/intents/intent/admissions', 'POST', original));
const [saved] = listGitCommandDrafts(storage, scope, 'project');
const restored = new TaskSaveReceipt(undefined,
  new GitCommandDraftStore(storage, scope, 'project', saved.key));
await restored.submit(async (path, method, body, key) => {
  assert.deepEqual(body, original); assert.equal(key, 'original-key');
  return {accepted:true};
}, '/ignored', 'POST', {changed:true});
```

## Task 2: Existing hook and owned recovery entry

**Files:** modify `useMutationReceipt.tsx`, `GitReview.tsx`, `GitIndexOperation.tsx`, `GitPanel.tsx`, `Workbench.tsx`; create `useGitMutationReceipt.tsx`, `GitPendingRequests.tsx`.

- [x] Let the existing hook accept an optional store, initialize its TaskSaveReceipt once, and preserve all current callers and pending/unload behavior. Do not replace its request engine.
- [x] Use a memoized Git store in review and index atomic commands. The namespace comes from `taskDraftScope()` after capabilities, not a caller-supplied owner. Key the Git panel by that namespace so an owner change unmounts stale state.
- [x] Add a recovery entry outside the current repository-snapshot gate: pending records must still be readable when current diff/snapshot is unavailable.
- [x] On mount/storage refresh, only list and show hints. An explicit retry uses a restored TaskSaveReceipt. Do not call native dispatch or resolve after the retry.
- [x] After confirmation, read the original current review or acceptance/status from authenticated APIs before showing GitReview/GitIndexOperation. For index control, obtain the original UI admission using the original execution's request ID, not an invented acceptance.
- [x] Pending records block unrelated new mutations while retry controls remain available. Invalid records show a recoverable error; they cannot inject a root, URL or command.

## Task 3: Actual reload and release acceptance

**Files:** create `web/workbench/git-request-remount-ui.test.mjs`; update implementation evidence and the existing scope ledger.

- [x] Intercept an original atomic request before forwarding, reload, and assert zero automatic POST/native calls. The explicit retry must preserve identical JSON and Idempotency-Key; dispatch remains a later explicit action.
- [x] Hold an actual Gateway pre-handler before business admission, reload, then let the original commit. Retry must recover the same one acceptance, not create another execution.
- [x] Repeat original review/control restoration and preserve the original control's frozen digest. Test another owner/project, malformed storage and write failure.
- [x] Run `node --test web/workbench/git-command-draft.test.mjs`, complete UI tests with `--test-concurrency=2`, root tests and local build. Run Gateway tests/build if its code changes; do not claim unrelated UI files as newly exercised Gateway inputs.
- [ ] Verify exact integrated source, original privacy and complete Git history, then make a scoped non-force upload. Keep all26, broader Git and platform/provider/deployment requirements open until separately proven.
