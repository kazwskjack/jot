# Original Chat native maintenance observation

This increment connects the completed-source and effective-pressure
prerequisites through an explicitly enabled read-only Host composition. It
does not perform compaction, create a background attempt, acquire or reuse a
foreground lease, account for inference, publish a checkpoint or enable general
Chat readiness. Original DSH planning and permission checks are unchanged.

## Native boundary

`createLiveChatRunCompletionReader` shares the original ordinary historical
completion parser. The original cold reader still refuses any registered Agent
or Session. The new live reader accepts only the already registered original
Chat Agent/Session and exact source; it never resolves an Agent or opens stored
Session files. It requires a published canonical answer, no pending supplements,
an empty live/projected inbox, closed successful native boundaries, original
immutable admission/entry records, complete command coverage, settled tools and
one final settled answer. Foreign, forked, changed or unpublished state fails.

The official `Agent.status` is also `idle` during maintenance. The new path
therefore awaits the public `whenIdle()` boundary and rechecks identity,
sequence and inbox. It has its own abort listener and never calls `cancel()` on
another operation. All native parsing/validation uses detached log snapshots;
the original native history remains intact.

## Joined source and pressure

`createChatMaintenanceObserver` reads the Gateway's original completed source,
checks its exact hash and owner/conversation/run/version/native Session, then
reads native completion. It uses the actual host token meter and exact routed
model metadata, not raw transcript size, and requires the current Chat route's
thinking-disabled policy. It rereads native completion after the asynchronous
pressure lookup; new input, state changes or inconsistent receipts fail.

The existing bearer-only Gateway source endpoint adds `verify-native`. The
authenticated Host sends a fixed-size metadata witness: original proof/log
hashes, command/native-message ID-list hashes and counts, source/profile hashes
and answer/turn boundary numbers. Full tool results and answer bodies stay
local. The Gateway uses original ordinary-run source/command coverage, rereads
the current source inside the existing transaction helper and compares the
attested native text hash to the committed canonical answer. It validates this
bounded Host attestation; it does not pretend to independently replay an
unsent log. The shared full native parser remains on the owned Host. No record
is created or modified. Leases, raw body fields and unknown fields are rejected.

The Host's opt-in `chat-maintenance-observation` endpoint returns that verified
metadata and pressure advice, with `execution_authorized: false` throughout.
Low or unavailable pressure quietly skips. High pressure is still only advice.
It is not a reservation: future execution must recheck the source and native
state under independently fenced admission and official maintenance.
Generated profiles and production readiness stay unchanged and default-off.

## Verification and limits

The actual official Host case uses two original Gateway/Worker Chat questions,
a local scripted Messages provider and real Session, token meter, model
metadata and admission services. Both completed answers are inspected through
the authenticated Host-to-Gateway path. The test verifies low pressure, exact
source/native identity, no database writes during observation, exactly two
model calls and exactly two canonical answers. The next accepted input revokes
the earlier source. `compactionExecuted` remains false.

Focused adapter tests cover original cold recovery, live idle/maintenance
cancellation, missing or foreign input, unpublished answers, changed native
state, route drift, low/high pressure, data minimization, final-check races,
authentication, unavailable default and rejection of leases/unknown fields.
Gateway tests cover exact proof/source/canonical answer matching, wrong hashes,
foreign scopes, no writes and bearer/CSRF behavior.

Final inspection found that forwarding complete native tool results could
exceed the Gateway's existing 1 MiB body limit exactly when a large context
needed maintenance. A regression with two synthetic 1.2-million-character
bodies now verifies that the request and returned metadata stay below 2 KiB
for the fixture identities, regardless of those body sizes. ID lists are
hashed rather than copied. The body limit and actual retained native data are
unchanged; this is not truncation of evidence or a new input/token cap.

The full Gateway run before the bounded-witness transport refinement passed
1,783 tests with seven conditional skips and zero failures. The final targeted
Gateway suites passed all twelve tests after the refinement, and its local
Windows build passed. Root regression passed all fifty tests and its build.
The final Session adapter suite passed 638 tests, with 25 conditional skips
and zero failures. The public scanner passed all six scanner tests and scanned
967 source files. The reachable-history review retains only the same seven
previously reviewed findings (two generic example-path documents and five
neutral Office objects); it is not reported as an automated zero-finding scan.
Seven final actual official Host cases passed serially with no skips: the four
Chat cases, original Work, saved role and original cold final publication.
The new maintenance case used the bounded witness and verifies that a newer
accepted question also revokes the Host observation. This
document does not claim the unrun execution, background usage, checkpoint or
real-provider gates passed.

Continue the [original implementation sequence](../superpowers/plans/2026-10-18-portable-chat-work.md):
create an independent dispatch/accounting attempt, use official Chat-only idle
compaction with thinking disabled and cancellation, then retain a source-backed
summary that the next bounded request actually consumes. Keep the complete
background-compaction checkbox open until those gates pass.
