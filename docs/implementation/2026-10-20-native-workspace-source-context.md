# Maintained native workspace source context

The original family source identifies Sessions and ownership, but does not prove
their filesystem placement. The existing source host now exposes workspace
observations inside its original maintenance callback. No new runtime, planner,
HTTP endpoint, Agent, permission or Git writer is introduced.

Each observation contains the original Session reference, resident/cold/absent
custody, the exact native header cwd when present, and a digest of the original
header. Cold facts come from the held original storage writer. An absent member
has neither a cwd nor a header digest; it is not represented as an empty project
directory. Full headers, events and model options are not included in this view.

`inspectNativeWorkspaceSource` accepts only a context issued by that original
source host during its awaited callback. It checks the original synchronous
reservation and native maintenance again. Copies, JSON round trips and contexts
retained after the callback returns or throws are invalid. Existing callback
`check` and `recheck` methods also expire. The returned immutable observations
have `execution_authorized: false`; storing their bytes cannot preserve custody.

Resident maintenance now includes the complete header in its unchanged-state
check. Tests first reproduced a changed cwd reaching the operation, and a header
change after the operation being reported as success. Both cases now fail the
original maintenance check. Detecting a change after a callback ran is not proof
of rollback or absence of an effect.

## Executed verification

- Focused unit tests: 33 passed, no skips, failures or cancellations. Five newly
  added cases failed against the earlier implementation before the repair.
- Real installed SDK, original JSONL ownership and source host: 36 passed with
  no skips, failures or cancellations. Covers resident, cold and absent members,
  native create/resume exclusion, queued input and a competing process writer.
- Original Gateway/authenticated HTTP/real native runtime: all ten cases passed.
  The original fixture deliberately retains distinct native and configured Git
  directories. The observation reports that difference instead of concealing it;
  no Git effect, producer or Worker lease is allocated by this test.
- Complete adapter regression: 834 tests, 805 passed and 29 conditional skips,
  with no failures or cancellations. Skips are not acceptance evidence.
- Root regression: 67 passed. Root Vite build and Gateway local build passed.

Restricted-shell runs encountered OS denials for temporary hard links/junctions
and loopback HTTP. The corresponding complete runs above used the authorized
Windows user context; assertions and filesystem checks were not weakened.

## Remaining original integration

The configured physical Git tree, logical immutable shared-file store and native
isolated work directory remain distinct existing resources. These observations
are the input to their original association check, not that check itself. The
coordinator must resolve original Work grants/source journals, pin actual physical
root identities and preserve publication provenance; identical path text or file
bytes alone are insufficient.

Keep actual native custody and original synchronous Gateway/Worker authority
through physical effects, checkpoint coordination, publication, cancellation,
drain and settlement. A stage approval cannot silently authorize copying shared
or isolated files into a different repository. Reviewed publication and selected
index effects need their own exact original source and result evidence. The
existing HTTP/mobile execution workflow and the full capability ledger remain
open; this increment enables no production mutation route.
