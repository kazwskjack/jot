# Bind execution to the original native Session

An ordinary task must not follow a conversation's later native Session pointer.
That pointer is useful when choosing the next task's destination; it is not
authority to move an already accepted input, cancellation or recovered answer.
This increment prepares the existing execution path for the planned Chat/Work
separation. It does not yet expose a mode switch.

## Accepted identity and first dispatch

When an input is accepted through the existing transaction, a saved owned
conversation binding is copied to the run's `native_session_ref`,
`native_owner_id` and `native_conversation_id`. An idempotent message retry
returns the original run. It cannot refresh that run from a new pointer.

When no native Session has been allocated yet, those fields stay null. The
Worker resolves the initial destination through its existing trusted resolver
and pins all three fields under its original live lease before calling the
runner, staging context or native input. An existing frozen identity is reused
without consulting the conversation resolver. Conflicting identities, partial
bindings, cross-owner reuse, changed owner/conversation lineage, archived work
and stale leases refuse dispatch. SQL triggers prevent replacing or erasing a
non-null binding. Pinning does not create or wake a native Session.

The product runtime cursor remains the existing per-run hash identity. It is
distinct from the DSH controller Session and is not used as a substitute for it.

## Consumers

`ga_run_native_sessions` projects the original run identity for admission,
steering observation, cancellation, ordinary full-history observation,
historical final publication and its original delivery validity checks.
The Worker also uses the frozen reference for its original-input recovery.
The existing owner, archive, message, version, lease and output checks remain.

An explicitly accepted native Goal continuation stores its original Session
and owner/conversation lineage too. Execution and exact receipt retries check
that original source run; moving the next-input pointer does not transfer the
Goal to a new Session. Cancellation and stale lease checks still revoke
mutation. This changes the earlier test assumption that any pointer movement
itself revoked an already accepted control. No resume is automatically created
by the change, and the host must still apply the original Goal control protocol.

File tools can resolve the original accepted Session's owner/conversation after
the current pointer moves. The lookup combines current and saved identities,
requires exactly one owner/conversation result and retains the existing tool
authentication, artifact ownership and write-admission checks. It does not make
Chat a file-writing mode; Chat tool permissions remain separate unfinished work.

## Migration and remaining pointer readers

Migration adds nullable columns, an index, an immutable-binding trigger and the
projection. It does not recreate saved native Sessions or backfill old tasks
from today's pointer. An unbound legacy run retains the previous pointer-based
behavior until a verified live Worker pins its initial execution. This
compatibility projection is not evidence of an old task's exact historical
native identity. Do not enable cross-mode switching over ambiguous legacy
work; the mode acceptance/migration gate is still outstanding. An interrupted
original input with no frozen identity is explicitly refused by native recovery,
even if today's pointer looks usable. A frozen input, conversely, can recover
after the next-input pointer is removed without resending the original prompt.

The following readers deliberately remain outside this completed increment:

| Reader | Remaining integration |
| --- | --- |
| New conversation destination / `SessionBindingRepository` | Allocate and preserve separate Chat/Work mappings without rewriting the saved Work identity |
| Public Goal view and new control admission | Continue to address the Work Goal explicitly; gate switches on active or unknown native outcomes |
| Role/task native children, workspaces, web-budget grants, checkpoint/business acceptance | Preserve their existing Work authority; verify mode changes cannot enter or borrow these scopes |
| UI and standalone runtime | Implement their distinct explicit mode contracts and readiness checks |

No complete Chat/Work capability or full Session-pointer migration is claimed.
See the [remaining implementation plan](../superpowers/plans/2026-10-18-portable-chat-work.md).

## Verification

Regression tests exercise an original native Session A followed by a current
pointer B. They verify the actual Worker destination, immutable retry, original
input authority, historical answer scope and cancellation destination. Negative
cases cover foreign owners, conflicting Sessions and stale leases. A reopened
database test verifies a legacy pointer survives migration, legacy runs stay
unbackfilled, and a new accepted binding survives pointer movement and restart.

The installed SDK `0.2.1-rc.2` verification adds a real Worker/Runner case whose
mutable resolver throws if consulted: the accepted Session A still executes
with its frozen model and produces one canonical answer after the pointer moves
to B. The hard-exit case now also moves the pointer before a fresh Host restores
the exact original native message. Both use local scripted providers and the
same original admission/recovery contracts; no live-provider or deployed preset
acceptance follows from them.

Final verification on the integrated source:

- Gateway full suite: 1,751 total, 1,744 passed, seven skipped, zero failed;
  Windows local Gateway build passed.
- Actual installed SDK: six cases passed, zero skipped. These include the
  original Worker/Runner publication after pointer movement and the separate
  force-terminated Host recovery case.
- Portable root: 50 passed; Vite build passed.
- Source privacy review: 923 files scanned successfully. Reachable-history
  review found only the previously reviewed generic example paths and neutral
  Office objects; no new identity or credential finding was introduced.

The first integration run exposed two old pointer-based test assumptions.
Their replacements verify frozen identity stability rather than mutable-pointer
metadata changes. A separate failing regression also reproduced ambiguous
legacy recovery; the Worker now refuses it. The complete final run above was
performed after those changes, not inferred by adding focused test counts.

This work does not deploy production or export private histories, browser
state, credentials or installed SDK artifacts.
