# Original Git producer lifecycle

An admitted Git request can remain pending after the process that began preparing
it has failed. Previously, the absence of a preparation/dispatch row alone allowed
the same request to start preparation again. This could repeatedly attempt a
known failure or mistake an interrupted producer for an operation that had never
started.

## Original execution integration

`GitIndexExecutions` now records an immutable producer start in the same original
transaction as its Worker lease, before calling the existing index kernel. The
record fixes the original execution, request digest, configured binding and exact
lease owner/generation. Failed persistence rolls back the lease; admission still
performs no filesystem effects and acquires no execution lease.

The original executor appends a separate immutable finish fact under its current
lease. It distinguishes failure or cancellation before preparation, preparation
without dispatch, unknown dispatch and an applied outcome. No raw exception,
working-directory path, credentials or subprocess diagnostics enter these facts.
The producer fact is distinct from the accepted HTTP response, physical outcome
and explicit owner disposition.

An unclosed producer is running only while its exact original lease remains
current. Lease expiration or replacement makes it interrupted; neither observation
proves that nothing happened. A pending request with a prior start cannot start a
new producer. Known preparation failures require explicit disposition and a new
review rather than an automatic loop. Unknown effects retain the existing
evidence-based reconciliation and no-replay behavior.

New executions use protocol 4. Existing protocol 1–3 history remains readable;
an old pending admission lacking producer custody is `legacy_untracked`, not a
new dispatch grant. Mixed old producers must still drain before write activation.
Completed outcomes retain their original receipt across retries and reopening.
Explicit disposition witnesses now include the producer facts, so a producer
transition invalidates an older disposition snapshot.

## Verification and remaining integration

The new tests use actual Git repositories and a child process that exits after
the committed producer start but before kernel preparation. They cover known
failure, cancellation, running exclusion, lease replacement, durable prepared
and dispatch failures, process loss, protocol-3 history and producer persistence
rollback. Existing effect, crash, ownership, receipt and API history regressions
remain required release gates.

This increment adds no route, tool, scheduler, native permission, generic shell
endpoint or UI write control. The original HTTP admission/producer lifecycle,
native/shared workspace coordination, configured-root binding, cancellation/drain
and actual workbench execution remain open in the
[HTTP workflow plan](../superpowers/plans/2026-10-19-git-index-http-workflow.md).
It does not close the Git capability or the full product ledger. DSH remains the
sole planner. No production configuration changes are part of this increment.
