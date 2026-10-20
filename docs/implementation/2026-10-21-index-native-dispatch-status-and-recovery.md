# Original index dispatch, status and explicit recovery continuation

This private continuation follows the published original admission/evidence
increment. DSH remains the planner. Reuse the original owner, review, physical
database, workspace family, native custody, Worker and immutable receipts.
There is no new planner, operation registry, queue or result authority.

## Implemented, not yet released

- Original UI status reads execution/inspection, producer, workspace settlement,
  original control admission and control receipt in one read-only snapshot.
  It cannot adopt internal work or transfer an old execution to a new owner.
- Explicit dispatch accepts only an empty command body and original IDs. It
  requires a not-started producer and original pending acceptance; a known
  failed/interrupted producer requires reconciliation. Peer JSON is ignored
  as evidence: success requires the original database's applied result and
  verified released/settled workspace.
- Explicit resolution requires an already admitted exact original owner control.
  The owning service can close positively proven never-started work without
  a native client. Started/reserved recovery uses the original authenticated
  channel. Physical control completion alone cannot release a held workspace.
- Existing HTTP ownership/CSRF/idempotency boundaries apply before cached
  transport receipts. Native I/O is outside the atomic admission transaction.
  A pending unknown HTTP transport request is not automatically executed again.
- Shared JSON/YAML/operation/event definitions and frontend types/client methods
  distinguish these states. Client commands retain explicit reusable keys and
  exact bodies; status reads are no-store and cancellable.

Thirty-six related HTTP/status/admission/contract cases passed with no skips.
All17 client tests passed. Three direct status cases passed, including actual
SDK evidence that a completed physical control remains visibly held until fresh
native drain settles. Local typecheck and Gateway build passed. These are
focused results, not full-suite, production or mobile selected Apply acceptance.

## Preparation defect reproduced and repaired

A real standalone BFF, loopback Gateway and authenticated separate native
process successfully reached reviewed stage and unstage, preserving HEAD and
worktree bytes. The larger scenario then failed before its third preparation.
It is recorded as a failed integration test, not an end-to-end pass.

Initial fixture errors were diagnosed separately: a named-pipe name did not
match the existing required prefix and was corrected without changing product
validation; an early-response race originally hid the underlying refusal.
Private test-process diagnostics now expose the original refusal to the test
parent, while product errors remain sanitized.

The actual refusal is `git_snapshot_changed`. A read-only metadata comparison
found a pre-existing loose blob's timestamps changed during preparation.
A standalone stage/unstage/re-stage preparation regression reproduced the same
source-object mutation without BFF or native IPC. The original failing regression
is retained in the local evidence; the repaired regression now passes.

The planner calls Git `hash-object -w` with a private writable object directory
and the source object database as an alternate. Git's existing-object freshening
can update timestamps; its upstream implementation uses `utime` for this
[freshening behavior](https://github.com/git/git/blob/master/object-file.c).
The observed mutation invalidates the original exact metadata snapshot. Do not
hide it by dropping object witnesses, treating the source as unchanged,
automatically re-approving a changed snapshot or disabling a permission check.

Planning now preloads only selected indexed blobs and their indexed attribute
ancestors into its bounded private object store. Source reads use Git cat-file;
each blob is verified using the repository's SHA-1 or SHA-256 object format.
Writable hash-object operations no longer see the source object store as an
alternate. Existing effect dispatch still uses the original approval, physical
snapshot and Worker/native custody checks. No entire object store is copied.

Six focused cases cover repeated preparation with loose/packed SHA-1/SHA-256
objects, original indexed-attribute behavior and original CRLF conversion.
The latter two expectations were independently checked against the published
kernel: this change preserves its controlled hash-object behavior and does not
claim the complete attribute fallback semantics of git add.

The actual BFF/Gateway/authenticated separate native-process scenario now passes:
stage, unstage, interrupted third preparation, original review cancellation,
explicit original control and fresh native settlement. Index bytes/inode,
worktree bytes and HEAD remain unchanged by cancellation/recovery. Worker
leases drain to zero, model calls remain zero, and replay of the original
resolution response after stopping the native peer does not re-execute effects.

## Original history and mobile reads

The original execution service discovers UI-admitted operations from the same
physical database, excluding internal operations. Read-only keyset pagination
is owner/project bound, validates immutable admissions and returns current
producer, workspace and control state separately from historical acceptance.
Three history-service cases and the authenticated HTTP history case pass.

The workbench now has an on-demand operation-history entry and read-only detail.
It restores original operations after a full reload without local browser
acceptance metadata; reading an applied or disposed receipt grants no retry.
Held workspace status remains visible even when a physical result is recorded.
Pagination, scoped status reads and client cancellation reuse existing APIs and
resource handling. All18 client cases pass. Actual mobile BFF/Gateway history,
existing Git viewing and review acceptance pass together: three cases, no skips.
The history acceptance checks zero write requests, unchanged HEAD/index and no
localStorage use. It first exposed an invalid timestamp in synthetic project
data; only that fixture was corrected, with response validation retained.
Removing the history entry with the corrected fixture reproduces the missing
entry failure; restoring the exact component passes again.

These results do not prove selected Apply/recovery UI, complete cross-device
cancellation, full-suite regression or production activation.

## Frozen increment regression

The complete Gateway regression subsequently finished with2313 tests:2306
passes, seven conditional skips, zero failures and zero cancellations. All1143
enumerated source/root/test inputs remained unchanged throughout the gate.
Root67 and complete UI271 passed without skips. The configured SDK adapter
matrix passed852/852 without skips, using the reviewed native0.2.1 runtime and
the separately reviewed memory0.2.0 runtime for its memory component cases.
Gateway typecheck/build, frontend build and six publication-verifier tests pass.
The original139 HTTP operations,230 schemas and86 event definitions retain
their existing semantics; four new operations expose original index status,
dispatch, resolution and history. These results cover this increment, not the
subsequent selected Apply/recovery UI continuation or production activation.

## Required next work

1. Finish the combined regression and complete source/build/runtime gates for
   the repaired kernel, dispatch/status/recovery and original history increment.
2. Complete selected Apply/recovery UI, lost responses and other-device
   cancellation. Retain server-discovered history across reload. Then perform full
   source/build/runtime/disclosure/history/remote gates before publication.
3. Continue commit/destructive/remote Git workflows, wider producers and the
   original full all26/portable Chat-Work/provider/platform/deployment scope.

No production configuration, actual model, user repository or credential was
used. Failed cases and private diagnostics remain outside the public increment.
