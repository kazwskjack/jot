# Standalone mode acceptance prerequisite

The subsequent [Chat executor increment](2026-10-19-standalone-chat-execution.md)
now supplies opt-in execution. The unavailable behavior below describes this
prerequisite and remains the default when that route is not configured.

This implements step 1 of the [standalone sequence](../superpowers/plans/2026-10-19-standalone-chat-work.md).
The local `/api` server and extended `/v1` Gateway keep distinct contracts and
execution models. The existing standalone Work Agent remains its executor.

## Durable acceptance and compatibility

The standalone SQLite store adds `mode` and `version` to conversations and
`mode` and `conversation_version` to runs. Migration is transactional, leaves
existing content and identities intact and assigns legacy rows Work/version 1.
Creation uses explicit column lists so existing databases can be upgraded.

A new accepted input freezes the current conversation mode and version in the
same transaction as its original user message and run event. A duplicate input
request is resolved against its original text and run before inspecting current
Chat availability or conversation mode. A later setting change cannot reclassify
the old run or make its lost acknowledgement create another run.

Mode changes use one synchronous transaction for version comparison, active-run
exclusion and update. Queued, running and approval-waiting runs block changes;
terminal runs preserve their original accepted mode. Stale versions fail without
altering the current setting. The Agent loads its queued run from the store,
rather than trusting a caller-supplied mode or conversation copy.

## Current API and readiness

Capabilities explicitly advertise Work as the default and Chat as unavailable.
Legacy conversation creation stays Work; explicit Work is accepted. The new
`PATCH /api/conversations/:id` accepts `mode` and `expected_version` and retains
the original localhost, same-origin and CSRF requirements. The existing Fastify
configuration strips unknown schema fields; extra model input never becomes an
execution route. A definite CAS conflict requires a fresh read and explicit user
choice; this endpoint does not automatically replay a setting mutation.

Chat creation, switching and fresh message acceptance are refused until a real
Chat executor is connected. The store's acceptance gate defaults closed. An
internally prepared Chat fixture also fails before any Work provider call,
including when the caller passes a replacement Work label. No environment flag
advertises Chat readiness based solely on this schema prerequisite.

## Evidence and remaining implementation

Four new tests cover migration from the old schema and disk reopen, immutable
accepted runs and original-input retries after a mode change, transactional CAS
and all standalone active states, actual Fastify capability/mutation routes,
cross-origin and token refusal, unavailable Chat with zero accepted runs, and
the persisted-mode dispatch guard. The dispatch regression first demonstrated
one incorrect Work provider call; after the fix it observes zero calls.

The complete root suite passes 54 tests with no skips; the Windows local build
passes. Existing approval, cancellation, worker-pool, file/browser and proxy
regressions remain included. No extended Gateway/Host source changed here.

The standalone Chat provider policy, bounded immutable context seed, durable Web
allowances, real streamed request/answer acceptance and standalone mode UI remain
steps 2 and 3. The parent Chat/Work item stays open. These tests do not establish
provider compatibility, live latency, production activation or full PilotDeck
capability completion.
