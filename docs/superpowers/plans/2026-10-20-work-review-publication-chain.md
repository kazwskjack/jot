# Original work review and publication chain

**Goal:** Complete the existing isolated-result review, explicit publication and
Git/checkpoint coordination without replacing DSH or its original authority.

The existing frozen candidate already retains the complete inspected base/result
manifests, diff, selected objective, source, plans, call-set and inspection hashes.
`TaskReviewOutputs` currently returns only selected file downloads. Expose the
existing evidence through that same owned pending-review read, not a second
review store or a guessed filesystem mapping.

The locally pinned PilotDeck reference uses a real workspace and directory leases
for Agent turns, checkpoint restore and repository operations. Its
`docs/chat-checkpoints-git.zh.md`, `src/session/checkpoints/repositoryOperation.ts`
and `src/session/worktree/resolveCanonicalRoot.ts` distinguish real repository
identity from an arbitrary path. Jot additionally has logical immutable blobs and
isolated copies. A directory match, matching bytes, artifact delivery or a task
acceptance is not approval to copy them to a configured checkout.

## 1. Existing review evidence, end to end

- [x] Add a pure projection of the already verified frozen work evidence. Recheck
  inspection, manifest and recomputed diff hashes. Return relative inventory and
  original IDs/hashes only; never private root, device, inode or host paths.
- [x] Extend the existing pending-review list read within its original deferred
  DB snapshot. Preserve owner, expiry, current candidate, original proof and
  output-byte validation. Ordinary reviews retain their existing response.
- [x] Extend the existing client and review card to show complete inventories,
  selected objective and changed paths, including rename and mode-only changes.
  Keep existing exact-version downloads. Escape all displayed content, abort
  stale reads on interaction/version changes and never infer apply permission.
- [x] Verify actual original isolated write/inspection/proposal/candidate evidence,
  foreign/resolved/expired/revoked reads, corruption and no new execution/events.
  Verify the React rendering and client boundary, then required builds/tests.

Current evidence and the deliberately interrupted first full gate are recorded
in [implementation and verification](../../implementation/2026-10-20-complete-work-review.md).

## 2. Original explicit publication, not implicit staging

### Source and target evidence to retain

The next source reader must follow original immutable records, not extend
`currentTaskCompletionCandidate` to accept completed/foreign runs. The current
reader intentionally requires a live waiting-approval candidate; finalization
changes the run/checkpoint and publishes reviewed attachments atomically.

For completed work, derive the source from the original owned
`wb_task_finalizations` row, its original business certificate/review, exact
candidate and snapshot hashes, native completion intent/proof and producing run.
Revalidate original per-file execution receipts and immutable version bytes using
the existing historical isolated/shared readers. A historical certificate/read
does not restore old task/role permissions or authorize a new filesystem effect.
Absent/corrupt receipt, mismatched occurrence, replaced candidate, missing bytes
or ambiguous source refuse rather than reading a mutable isolated tree or latest
same-named file. Retain the original uploads and generated-artifact provenance.

The publication review must separately bind both the source base/result versions
and the actual configured target's fresh before-state witness. Matching project
IDs, directories or bytes do not establish this relationship. Show the actual
target changes to the owner; a target change after that review conflicts before
effects. Do not synthesize a Git repository around an isolated copy, merge a new
target automatically, or treat a rename inferred by content as approval itself.

The eventual source reader, target review and producer must use the same original
database and project/native coordination. Scope the supported content explicitly:
verified isolated text proofs currently exist; other producers need their own
original byte/receipt validation. Unsupported binary/generated/shared paths stay
visible as unfinished integration, not silently excluded from the final goal.

- [x] Read finalized isolated text sources from their original same-database
  finalization, accepted certificate, candidate, native completion proof,
  inspection and immutable per-version receipts. A physically read-only database
  is supported; no current execution permission or target publication is implied.
  See [historical source implementation](../../implementation/2026-10-20-finalized-work-sources.md).
- [ ] Bind that original source and its immutable proof to
  owner/project/workspace, source versions, chosen paths, base/result manifests,
  original inspection and actual configured target identity in a distinct intent.
  No request-supplied root, executor, shell or mutable latest-version fallback.
  Internal target observation and immutable review are now implemented for the
  supported text-file source paths; see
  [target review implementation](../../implementation/2026-10-20-work-publication-review.md).
  This item remains open until original producer consumption and product entry
  are connected; an internal prepared/approved record grants no file effect.
- [ ] Review the actual target diff against its original base. Changed targets
  conflict before effects. A task acceptance/delivery cannot authorize apply.
- [ ] Retain original project reservation and native maintenance, including source
  journals and exact Worker producer custody. Coordinate shared writes and
  checkpoint restore through the same owning path, including overlapping roots.
- [ ] Journal per-file preparation/publication and immutable recovery evidence.
  No SQL transaction across awaits; no overwrite of unrelated changes or secret
  paths. Multi-file interruption retains unknown/partial state, never automatic
  replay, guessed rollback or release based on lease expiry.
- [ ] Expose apply/current/disposition only after original recovery semantics and
  cross-process acceptance pass. Verify changed/missing roots, cancelled approval,
  process loss before/after publication, restart and foreign owner rejection.

### Target review implementation sequence

The current Git `freeze` intentionally accepts paths present in the dirty status
inventory. Publication also needs unchanged tracked targets and absent new files.
Do not loosen stage/unstage selection or manufacture dirty files to reuse that
method. Add a distinct read on the same configured repository inspection that
retains its original physical-root/program checks, bounded no-follow byte reads,
nonexecuting metadata copy, cancellation and owner checks after awaits.

1. Read the original finalized source by owner and run, retaining its complete
   source digest and explicit unsupported changes. Select only exact relative
   paths in that frozen source; caller input supplies no root or replacement bytes.
   Reject unsupported operations rather than approving a partial tree silently.
2. Collect the actual configured target's fresh repository/root identity, HEAD,
   index and selected path witnesses, including clean files and missing paths.
   Recheck physical directories and all selected bytes after asynchronous reads.
   Missing ancestors, symlinks, hardlinks, case aliases and secret/metadata paths
   require explicit rejection or their own implemented semantics.
3. Compare each selected target with the reviewed source base. An absent source
   base path requires an absent target. An existing base requires exact bytes and
   supported mode/type. Show source-base/result and actual target-before hashes
   together with the actual proposed changes; never silently rebase onto drift.
4. Save a distinct immutable intent in the original database after those reads.
   Bind original source/candidate/inspection IDs, selected paths, before/result
   hashes, target configuration scope and physical witnesses. Retries with the
   same request ID return that intent; changed payloads conflict. No filesystem
   mutation or SQL transaction spans an await.
5. Approval binds the owner's exact intent version and review digest, then
   revalidates current ownership, source history and target witness. Revocation,
   target change and changed source are terminal conflicts for that review;
   approval does not dispatch work or acquire a substitute lease.
6. Only the original producer coordinator may consume an approved intent, under
   project reservation and complete native-family custody. Retain the existing
   shared write/checkpoint barriers and original Worker lease through awaited
   preparation, per-file publication and settlement. Journal before effects.
   The current `workspace-coordination.ts` source type and table constraint
   accept only `git_index`; its settlement reads original Git index producer and
   outcome tables. Extend that original typed protocol and controlled schema
   migration for publication, preserving existing reservations, immutable hashes,
   member fences and foreign keys. Do not label file publication `git_index`,
   release it through index-only evidence, or create a parallel exclusion store.
   The original authenticated native-family hosting must carry the distinct
   approved publication/source identity through the same live custody boundary.
   Follow SQLite's [generalized table-change procedure](https://www.sqlite.org/lang_altertable.html#otheralter)
   on a controlled, quiescent maintenance connection, including preservation of
   dependent triggers/views, full foreign-key checks and rollback. A synthetic
   Node/SQLite probe reproduced deferred-only replacement failing at commit;
   the maintenance procedure retained original/dependent rows and triggers and
   rejected a genuine injected foreign-key violation. This is mechanism evidence,
   not acceptance for the original schema or permission to modify a live service.
7. Prove separate-process interruption before preparation, between files, after
   effect/before acknowledgement, and after acknowledgement/before settlement.
   A restart reads original evidence; it cannot infer rollback, replay unknown
   writes or release custody merely because a timer expired. Connect mobile/API
   apply and disposition controls only after those exact paths pass.

Target-read acceptance must exercise a real configured repository with clean
tracked files, a new nested target, unrelated local modifications, changed HEAD
or index, root replacement, symlink ancestors, cancellation during reads,
ownership transfer and a source finalized in another database. Successful review
must leave both working tree and index byte-for-byte unchanged and create no
model call. These cases remain unimplemented until backed by executed evidence.

## 3. Original Git/checkpoint/mobile closure and release

- [ ] Use the established publication provenance to associate maintained native
  workspaces with configured Git roots; preserve distinct shared/isolated roots.
- [ ] Keep live admission, original lease, source and repository checks at physical
  effects and awaited settlement. Unknown outcomes retain original custody.
- [ ] Connect original HTTP/BFF/contracts and mobile execution/current/disposition
  controls; verify real index/file bytes after lost acknowledgements and restart.
- [ ] Run root/UI/adapter and relevant SDK/Gateway verification, local builds,
  source/staged/history disclosure review and exact non-force remote verification.
  Record unsupported platform/provider/deployment checks separately. All other
  PilotDeck and portable Chat/Work requirements remain open.
