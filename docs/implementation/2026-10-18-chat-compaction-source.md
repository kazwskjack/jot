# Completed Chat source for background maintenance

This is the completed-source and immutable-intent prerequisite in task 4.
It does not run compaction, create a model attempt, enable Chat readiness or
claim the native Session is idle. Actual idle/pressure checks, independently
fenced execution, cancellation, usage accounting and checkpoint handoff remain
required by [the implementation sequence](../superpowers/plans/2026-10-18-portable-chat-work.md).

## Source boundary

The reader reuses original ordinary-run historical observation. It verifies
the exact owner/conversation/run/version/native Session; latest accepted
input; absence of live foreground authority and unapplied supplemental input;
the complete canonical answer and its committed publication event; immutable
Chat execution/model policy; the resolved thinking-disabled model; and the
exact bounded-context digest. Work, active/archived/foreign/stale sources are
refused. An expired original lease row is historical evidence, not a lease
that can be reused for background execution.
Legacy current-conversation Session fallback is insufficient: the accepted
run must retain its own immutable native owner/conversation/Session identity.

An answer reconciled through the original historical publisher may retain its
original interrupted execution status. Its frozen pre/post source and native
completion metadata must validate against the canonical answer. The reader
does not relabel that run succeeded, republish the answer or bypass the
original reconciliation receipt.

The returned record contains identities, revisions and hashes, plus the
nonsecret accepted policy/resolved model. It does not copy the conversation's
raw prompts, answer text or image bytes. `execution_authorized: false` is
mandatory. Gateway completion evidence alone is not native idle permission.

## Immutable intent and transport

Preparing an intent captures the current source in canonical JSON and hashes
it, once per original run. Retries/read reuse the same opaque identity and
exact bytes. Database triggers prohibit updates. Preparing/reading does not
create a run, public event, answer, model request or execution lease.

The internal bearer-only `chat-compaction-source` route accepts `inspect`,
`prepare` or `read` with the original owner/conversation/run/version/Session
scope (`read` also requires the intent ID). It rejects a foreground
`execution_lease` field and unknown fields. Inspect is read-only; prepare only
records source provenance. No inference or maintenance action is accepted.
It retains bearer authorization when browser CSRF is configured.

Every read/prepare rechecks the live source. A newer accepted question,
changed answer/policy/binding or invalid authority makes the old intent
unavailable for execution, while its frozen record remains available to the
future separately authenticated accounting path. There is no accounting API
or model attempt in this increment, and a retained row is not a grant.

Migration creates an empty journal and never invents intents for existing
answers. Disk reopen retains exact intent/source bytes and update protection.

## Verification

Eleven focused tests cover post-publication-only preparation; no extra public
effect; exact retries; owner/Session/version isolation; newer-input revocation;
changed answers; real original historical-publication writer integration;
unapplied supplements; expired versus live leases; disk reopen/migration; and
the bearer-only no-lease transport; and refusal of legacy mutable Session
fallbacks in place of the original run identity. These database tests use synthetic inputs
and do not claim that native inference or compaction occurred.

The actual official Host test runs two real Gateway/Worker Chat questions
through a local scripted Messages provider. Each publishes one answer. Source
inspection adds no database writes, preparation adds only the journal row,
and repeats keep the same intent. The second input invalidates the first
source and receives its own intent after its answer commits. The test observes
two model calls and two answers in total, with `compactionExecuted: false`.

The Gateway full run passed 1,781 tests, with seven conditional skips and zero
failures. It preceded the final original-run identity hardening; the final
eleven-test focused suite verifies that stricter boundary and the unchanged
positive paths. The final Gateway Windows build also passes. Root regression
passed 50 tests and its Windows build; the unchanged adapter suite passed 615
tests with 25 conditional skips and zero failures.

The first six-case Host run overlapped the larger Gateway regression: two
cases passed and four timed out before readiness, with empty Host output and
zero model requests. The same six cases then passed serially after the larger
run ended, retaining the original readiness deadline. This is not proof of
the exact startup bottleneck, and the initial run is not relabeled green.
Neither selected run is a new full monolithic Host-suite acceptance. No live
provider quality, production rollout or general Chat readiness is claimed.

The background-compaction checkbox remains open: this prerequisite neither
replaces the official compaction engine nor spends tokens to produce a summary
that would be discarded by the next bounded seed.
