# Verified native checkpoint handoff

The opt-in `checkpoint-text-v2` context revision now carries a verified native
summary into the next original Chat request. Existing context revisions retain
`recent-text-v1`. This closes the useful checkpoint prerequisite; it does not
enable automatic maintenance, general Chat readiness or production rollout.

## Publication follows the original execution

The Host validates the unchanged original raw prefix against the shared native
completion proof. It checks the exact standalone start, summary, adjacent
replacement and successful end, original operation identity, model, native
selection, accepted context marker, original native inputs, surface generation
and durable flush. A bounded witness contains hashes, sequence metadata and
actual usage; full native history, tools and image bodies remain local.

The official engine may retain the final assistant answer outside its selected
span. The witness records whether that answer was actually selected. Retained
answers are carried as recent text rather than falsely marked as summarized.
No custom range selection or replacement of the official planner is introduced.

The bearer-only `chat-compaction-checkpoint` internal endpoint admits one
immutable checkpoint per original intent/attempt. It requires that attempt's
exact owner/conversation/Session/source, observer/fence, settled usage and
thinking-disabled route. It compares native usage with the independent journal
and rechecks the still-current completed source inside the publication
transaction. A new input or changed source prevents a new publication; it never
erases incurred usage. An exact already-persisted retry can return its original
receipt after eligibility changes, without a new inference or message.

The journal stores bounded text, native hashes/span/generation, policy, exact
covered-message revisions and an immutable parent checkpoint reference. Empty
migration creates no historical summaries. It creates no public assistant or
human message, run, outbox event, foreground lease or model grant. All receipts
retain `execution_authorized: false`.

## Acceptance and native context

Original acceptance freezes the latest compatible checkpoint for the exact
owner/conversation/Chat Session and policy. It combines that text with the
newest complete text excerpts under the existing 14,000 UTF-16-character total
boundary. The accepted current input remains separate. The checkpoint text is
limited to 6,000 characters as an internal data format, not a user task/model
token quota; an oversized or malformed result cannot be published as a useful
checkpoint. No forced foreground summarization is added.

Coverage follows the accepted original snapshot and actually selected inputs.
A covered message is excluded only when its content hash and revision still
match. Edited text re-enters the recent window. Parents retain older coverage
without copying the complete ancestral list into each checkpoint or model
request. The native selector verifies the versioned schema, text hashes and
exact framing before its existing append-only surface replacement. The stable
system/tool prefix, full native log, canonical transcript, attachments and
immutable original admission/retry remain intact. Work remains unchanged.

## Evidence

Gateway tests cover ownership, current-source refusal, invalid span/generation,
changed text/usage/source/operation, unconfirmed accounting, exact replay,
immutable SQL rows, shared escaped-text bounds, frozen acceptance, disk reopen
and empty migration. Route tests retain bearer authentication with CSRF enabled
and reject foreground leases and extra fields. Adapter tests bind native
selection/replacement/generation, reject partial or changed records and validate
both context formats before a surface change.

The actual pinned official Host, real Gateway/Worker and local scripted Messages
provider demonstrate two consecutive checkpoint generations. Four original
questions plus two separate auxiliary summaries produce six requests and four
canonical answers. Each next original request contains the exact summary once
and the official retained answer once, with the original system/tool prefix.
The second stored checkpoint refers to the first. A separate live-SSE v2
cancellation case succeeds on the new original question, retains unknown usage
and publishes no stale checkpoint. These are synthetic-provider SDK integration
results, not live-provider speed, price, quality or cache-hit claims.

The release review also checks the bearer-only route with CSRF enabled, exact
native coverage and parent hashes, unchanged v1 framing, explicit package-file
inclusion and the absence of new public messages or foreground grants. Root
tests passed 50/50 and the Windows frontend build passed. The complete adapter
test entry passed 662 tests with 25 conditional skips and zero failures; the
Gateway Windows build passed. The complete Gateway regression passed 1,798 tests
with seven conditional skips and zero failures (1,805 total). An earlier run
whose process handle disappeared without a final summary was not counted.
The final serial official-Host regression passed all 13 selected cases with no
skips or failures: ten Chat cases, ordinary Work, budgeted role and historical
original final publication. It uses the actual pinned SDK and local scripted
provider. The preceding run had one startup-readiness timeout before inference
and 12 passes. The unchanged single-case recheck and then the complete 13-case
recheck passed with the original deadline; no source or timeout was changed to
make that failure disappear. Its precise startup delay remains unexplained and
is not counted as a passing attempt or production reliability evidence.

## Remaining activation gates

Automatic starts are still absent. Crash/restart recovery of publication across
Host termination, Chat-only hidden activity versus visible Work compaction,
actual provider/cache timing, UI/standalone integration and the broader full
capability ledger remain open. A native summary that cannot be published is not
silently claimed as a useful handoff. General readiness and generated profiles
remain default-off until the remaining end-to-end gates pass.

The replacement-order gap identified by this review is now addressed in the
[native surface-order increment](2026-10-19-chat-native-surface-order.md).
Protocol-2 evidence follows actual surface positions and visible markers; its
actual SDK test replaces a context node before original compaction. Existing
protocol-1 records keep their original validation. This closes that specific
prerequisite, not the remaining automatic activation or recovery gates.
