# Original historical work snapshot read

## Purpose and authority

A project can retain native Sessions from more than one isolated work cycle.
The original live `WorkspaceJournal.intent` and `record` methods correctly
reject a closed cycle. Reopening that cycle to inspect its directory would
incorrectly restore execution authority. Requiring a completed output for every
historical member would also omit failed or interrupted work from coordination.

`readHistoricalWorkSnapshot` is a separate host-private, read-only derivation.
It reuses `WorkAdmissionRecords.byRun`, `WorkGrants.get`, canonical JSON/hash
checks and `validateWorkspaceRecoveryRecord`. It checks the immutable snapshot
intent and record against the original grant and scope. It performs no schema
installation, filesystem read, lease acquisition, snapshot repair or task
state change. The live journal and work-run guards remain unchanged.

The result deliberately has `execution_authorized: false`. It proves neither
native Session association nor current physical directory identity, quiescence,
completed output eligibility or permission to write. Those remain subsequent
checks under the original reserved family and producer.

## Reused implementation

| Code | Function | Reason |
| --- | --- | --- |
| `packages/gateway/src/always-on/work-snapshot-history.ts` | Original historical snapshot derivation | Closed cycles need immutable facts without live reauthorization. |
| `packages/gateway/src/persistent-tasks/finalized-work-sources.ts` | Reuses that derivation for finalized source placement | Avoid duplicating the original grant/intent/record checks; retain completed-output, base-manifest and native-checkpoint checks in their existing layer. |
| `packages/gateway/test/always-on/work-snapshot-history.test.mjs` | Two original admissions, closed history, read-only restart and corruption refusal | Exercise original task APIs and original database records rather than invented history rows. |

## Current acceptance boundary

The three focused tests and Gateway typecheck passed locally. The tests
use two distinct original work admissions and snapshots in one project, prove
the old live guard still refuses a closed cycle, and verify that physical root
relocation does not turn this historical read into repair or live validation.
A rehashed replacement record cannot bypass the original grant binding. The
second original work run was failed through its original coordinator and its
artifact cycle explicitly closed; historical snapshot read remained unchanged,
while finalized-output selection still refused that failed run.

The prior publication producer increment was published as `f0f5eb7`; its full
2,195-case regression is evidence for that original tree. It does not certify
this later extraction. A separate 45-case source/publication/placement/process
crash regression passed with zero failures, cancellations or skips and available
local DSH SDK cases explicitly enabled. After adding failed-history assertions,
the three historical-read tests passed again. No provider/model call or
production deployment is established by these synthetic tests.

The subsequent [full-family and native transport implementation](2026-10-20-publication-family-and-native-transport.md)
derives original member associations, retains multiple historical physical
roots and extends the existing authenticated Host transport. It records its
own evidence and remaining gates. A historical snapshot result alone does not
close that end-to-end chain; owner Apply/recovery UI and broader acceptance
remain separate requirements.
