# Native Chat checkpoint surface order

This increment closes the replacement-order prerequisite identified in the
[checkpoint handoff review](2026-10-18-chat-checkpoint-handoff.md). It preserves
the existing original DSH engine and bounded next-request context; it does not
enable automatic compaction, general readiness or production deployment.

## Reproduced defect

The pinned official SDK defines `shadowedSeqs` in surface order. An append-only
replacement has a newer sequence number but occupies the old node's position.
For example, the actual official Host test produces a selected surface
`[29, 23, 24]` with boundaries `29` and `24`. Treating these as an increasing
numeric interval incorrectly rejects a valid official result.

There was a second related assumption: the evidence reader counted every stored
context marker for the run. After a legitimate replacement, the old marker
remains in raw history but is no longer visible. Counting both mistakes retained
history for an ambiguous current context. The actual SDK case failed at this
check before the correction.

## Correction

The Host verifies unique selected sequence IDs against the exact contiguous
slice of the original surface, in its original order. It verifies the resulting
surface, generation, unchanged raw prefix, official summary/replacement/end and
original input identities as before. Only visible context markers are eligible;
multiple visible markers still fail. Raw history is never rewritten.

New witnesses use protocol 2 and add five bounded integer facts: surface node
count, selected start/end positions, context-marker position and canonical-answer
position (`-1` means absent). The selected-node hash and native sequence IDs
remain intact. The Gateway checks count/span consistency, bounds, distinct
marker/answer identities and positions, endpoint identity and actual positional
answer coverage. It no longer infers coverage from numeric sequence intervals
for protocol 2. Full node arrays, tool bodies and native transcripts do not cross
the internal route.

The protocol-1 branch retains its original validation so existing durable
checkpoints and exact retries remain readable. The public checkpoint receipt,
context revision, source policy and owner/Session/attempt/fence/usage authority do
not change. Native sequence ordering is evidence, never permission.

## Acceptance

Focused regressions first failed on the unsupported order, then on duplicate
stored markers and inconsistent position/sequence facts. The corrected focused
suites pass both covered and retained-answer cases and reject duplicate nodes,
changed order, changed replacements, malformed positions, contradictory endpoint
identities, extra fields and out-of-range facts. Existing protocol-1 publication,
exact replay, source drift, cancellation, disk reopen and v1 context tests remain.

The actual official Host test uses `Session.append` to replace only the visible
context marker, then invokes the original manager and `compactNow`. It verifies
the reversed numeric boundaries in the persisted protocol-2 witness, retains the
unselected answer, and carries two checkpoint generations through four original
questions. Six local scripted-provider requests yield four canonical answers,
including the two independently accounted summaries. The same test failed
before the visible-marker correction and passed after it. This is actual SDK
integration with synthetic provider responses, not live-provider quality,
latency, price or cache-hit evidence.

The final serial official-Host suite passed 14 selected cases with no failures
or skips. This includes the original ten Chat cases, the new replacement-order
case, ordinary Work, a budgeted role and original historical final publication.
Root tests passed 50/50, the complete adapter entry passed 663 with 25 conditional
skips and no failures, and both Windows builds passed. Public source review
passed 996 files and six scanner tests. The earlier intentionally failing
reproduction runs are not counted as passes. Final Gateway counts are recorded
only after its complete regression terminates: 1,799 passed, seven conditional
skips, zero failures (1,806 total).

Host-exit
publication recovery, post-answer automatic dispatch, activity presentation,
actual provider/cache timing, UI/standalone integration and the full capability
ledger remain separate unfinished gates.
