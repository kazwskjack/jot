# Original publication source custody and local file effects

## What changed

Completed work can now derive a private native placement from its original
finalization, grant, snapshot record and immutable source manifests. The
authenticated workspace source reader distinguishes `work_publication` from
`git_index`; legacy index requests retain their existing shape. A publication
cannot borrow an index inventory or supply its own root or executor.

`WorkPublicationExecutions.withReservedNativeSource` retains the original
project-family reservation and actual native maintenance handles across the
awaited callback. The callback receives an ephemeral private token. The approved
source, distinct source/target root identities, ownership and native admission
are rechecked. The nested original family observation is frozen; a copied or
expired context is refused. These observations are not file-write authority.

The configured Git service also has a local publication kernel in
`packages/gateway/src/git/publication-effects.ts`. It consumes the reviewed
target witness and immutable source bytes, stages exclusive sibling files and
checks the selected target again before publication. New files use no-overwrite
hard-link insertion; modified files use sibling rename. It preserves Git index,
HEAD and the isolated source, and does not invoke a shell, model or new runtime.
Missing structural parents are created only for the selected reviewed files.

The original source inventory remains unchanged. In
`work-publication-intents.ts`, a structural added directory is acceptable only
when it is an ancestor of an original selected file addition. A directory cannot
be selected as file material. Other unsupported operations still refuse.

The kernel requires synchronous preparation, intent, effect and completion
callbacks. A plan is consumed once. Revocation prevents subsequent effects;
unknown acknowledgements retain evidence and are not automatically replayed or
rolled back. These hooks still require an actual durable producer integration.

## Verified locally

- 35 focused cases passed: historical finalized sources, actual target review,
  private placement, typed authenticated source routing and local physical
  publication effects. This includes actual nested-file creation, preserving
  unrelated target content, review revocation, target drift, new-target races
  and a lost post-publication acknowledgement without replay.
- Two cases using the installed DSH SDK passed without skips: actual original
  native maintenance across an awaited callback, immutable family observations,
  serialized-context refusal and review revocation. They made zero model calls.
- Root application tests: 67 passed. Workbench/frontend tests: 253 passed.
- Session adapter suite: 844 total, 815 passed, 29 conditional skips, zero
  failures or cancellations. Skipped optional environments are not acceptance.
- Gateway typecheck/build and frontend build passed.
- Whole Gateway regression: 2180 total, 2158 passed, 22 conditional skips,
  zero failures and zero cancellations. The actual process returned exit zero;
  all 605 enumerated Gateway source/test/contract/script/template/package files
  matched the recorded fingerprints after it ended.
- Public-review verifier tests: six passed. The initial source-tree scan
  examined 1175 files without findings; final release review must inspect the
  final staged tree and reachable Git history separately.

Tests used synthetic local data. The restricted Windows context denied a file
hard link, blocked a loopback BFF call and prevented isolated Edge startup.
The affected tests were rerun successfully in the Windows user context. No
security setting, ordinary browser profile or production service was changed.

The whole Gateway regression is a separate release gate. Its terminal result
was inspected for this increment; earlier green suites against a previous tree
were not substituted for it. Conditional skips do not certify the optional
environments; the two explicitly enabled local DSH SDK cases above passed
separately.

## Still required for the product workflow

This increment is not end-to-end Apply acceptance and does not enable a public
Apply route. It does not change the DSH planner or install PilotDeck's runtime.

1. Consume the held source through the original Worker lease and persist a
   producer start plus preparation and each file intent/receipt in the original
   database. Never hold SQL transactions across awaits.
2. Validate producing native history against the original completed checkpoint;
   the current SDK fixture tests custody, not the historical checkpoint prefix.
   Reuse the original canonical-header/event-prefix checks in
   `packages/session-adapter/checkpoint.js`, but do not call its idle-waiting
   wrapper from inside held maintenance. The inspected installed DSH
   `runMaintenance` sets its activity promise until the callback returns, and
   `whenIdle` awaits that activity. Calling `verifySessionCheckpoint` there
   would therefore wait on its own callback. Reuse the checked readback under
   existing custody, without introducing a second barrier or restoring a Goal.
3. Reconcile interrupted and ambiguous effects after restart before allowing
   explicit disposition or producer-specific reservation settlement. Lease
   expiry alone is not proof that a file effect did not happen.
   Also resolve every retained native family member to its original placement.
   The current root association handles the producing isolated source plus
   ordinary members at the configured target; another historical isolated
   member is rejected. A project with multiple such task histories needs their
   original admission/grant/snapshot bindings, not a blanket exception for any
   directory or a test restricted to a single producing Session.
4. Connect the owner-reviewed product entry, mobile controls and actual
   Git/checkpoint coordination. Verify ordinary completion, cancellation,
   Worker/process loss and restart with real physical files.
5. Extend original evidence and reviewed effects for binary/generated/shared
   content, deletion, rename and mode changes. Current selected text
   additions/modifications do not certify those capabilities.
6. Verify supported non-Windows platforms and real deployment separately.

The full 26-capability and portable Chat/Work goals remain open. Source reuse
and required strengthening follow the
[pinned module comparison](2026-10-20-pilotdeck-reuse-strengthening-review.md).
