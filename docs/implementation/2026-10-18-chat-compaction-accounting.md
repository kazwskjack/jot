# Independent Chat compaction call accounting

This increment implements the independent dispatch/accounting prerequisite in
the original Chat/Work plan. It does not enable automatic background compaction,
compose `BasicCompactionEngine`, publish summary checkpoints, change the next
bounded seed or enable general Chat readiness. Work/role budgets, original DSH
planning and permission controls remain separate and unchanged.

## Durable identity and dispatch

`ChatCompactionAttempts` binds one attempt to one immutable completed-source
intent, original owner/conversation/run/version/native Session, Host observer,
opaque server fence, verified bounded native witness and exact request metadata.
The request records provider/model, thinking disabled, purpose `compaction`,
native Session and a hash of the assembled call; no raw prompt, image or answer
body is saved. SQL uniqueness and immutable-field triggers prevent a second
attempt ID, changed source/request or renewed ticket for the same intent.
Migration creates empty journals and never invents calls for old answers.

Reservation and first dispatch both recheck the current completed source and
native witness. A newer question, stale ticket or changed identity prevents
dispatch. The default 60-second admission ticket is a freshness fence, not an
inference timeout, token limit or new user budget. It is not renewed on retry.
Only the first durable `reserved -> dispatched` transition returns
`dispatch_allowed: true`; a replay returns false. Lost acknowledgements never
authorize a speculative second provider request.

All receipts still have `execution_authorized: false`. A journal/fence is not
an independent permission to use a model: the caller must hold the original
official native maintenance boundary and separately guard cancellation, source,
Session and model policy immediately before inference. There is no replacement
run, planner, scheduler or foreground lease.

## Usage and cancellation

States are `reserved`, `dispatched`, `usage_unknown`, `settled` and `released`.
Only never-dispatched attempts can be released. Dispatch and accounting events
are appended transactionally to a private immutable event journal, without
public message, outbox or progress events.

Accounting validates the frozen original identity rather than current execution
eligibility. It therefore remains available after new input, cancellation or
ticket expiry. Complete provider usage settles once; identical retries reuse
the same receipt and contradictory final usage fails. Tokens use disjoint
input/output/cache buckets; reasoning is part of output and is not added twice.
Missing cache buckets are zero only when an exact total proves no unassigned
tokens. Incomplete/absent usage stays unknown, retaining the reported sample;
unknown tokens and unconfigured monetary cost are `null`, never invented zero.
No price, invoice or externally measured provider charge is claimed.

`accountedChatCompactionStream` is an explicitly supplied decorator, not a
globally registered stream hook. It hashes supported assembled SDK request
fields locally, excludes the runtime signal, requires exact Chat thinking-off
compaction identity and refuses request changes across admission. It reserves
and records dispatch before invoking the provider. The terminal finish reaches
the summary consumer only after settlement. Cleanup/accounting requests use
their own bounded transport instead of the aborted inference signal.

Partial cancellation retains usage as unknown. If a terminal provider event and
complete usage have already arrived, cleanup can settle the incurred tokens
while cancellation still suppresses a successful finish/checkpoint. A lost
settlement response does not erase committed usage or authorize model replay.

The bearer-only `chat-compaction-attempt` internal endpoint exposes exact
reserve/read/dispatch/release/unknown/settle actions. It rejects browser/lease
fields and arbitrary model overrides, and retains bearer authentication when
browser CSRF is configured. Generated profiles do not start maintenance or
register this decorator automatically.

## Evidence

Database/API cases exercise original-source binding, one-time dispatch, expiry,
new-input revocation, late accounting, cache ambiguity, reasoning accounting,
cross-owner/fence/model isolation, independent connections and disk reopen.
Stream tests use the real Gateway/SQLite endpoint with a scripted provider
iterator to reproduce lost replies, cancellation and malformed/absent usage.

A separate actual official Host probe uses the real SDK `llm.stream` inside
the existing Agent's `runMaintenance`, with a local scripted Messages server.
Two original Chat answers plus one explicitly requested auxiliary call produce
three model requests and two canonical answers. The actual auxiliary request
has thinking disabled despite the provider's global high default; its exact
11-token usage settles in the independent journal. It leaves the Session log
unchanged and publishes no summary/checkpoint. This is actual auxiliary-call
accounting evidence, not automatic compaction or real-provider billing evidence.

Final regression results and remaining gates are recorded in the release
progress and the [implementation plan](../superpowers/plans/2026-10-18-portable-chat-work.md).
The full Gateway run passed 1,792 tests with seven conditional skips and zero
failures. Final adapter regression passed 647 tests with 25 conditional skips;
root regression passed all fifty tests. Both local Windows builds passed.
Eight selected actual official Host cases passed serially, covering Chat,
Work, saved role, original cold publication and the new auxiliary call. The
auxiliary success case was also rerun after stream hardening; these overlapping
runs are not added together as distinct cases. Nine stream/API cases cover the
failure boundaries, including mutable caller identity and malformed usage.
The public scan covers 977 files with six scanner tests. Reachable history
retains the seven unchanged previously reviewed generic-document/neutral-Office
findings, rather than an automated zero-finding claim.
The full background-compaction checkbox remains open until official summary
execution, own-operation cancellation/drain, checkpoint consumption and the
end-to-end gates are implemented.
