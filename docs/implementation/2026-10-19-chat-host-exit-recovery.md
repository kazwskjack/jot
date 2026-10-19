# Original Chat checkpoint recovery after Host exit

This increment implements the Host-exit prerequisite in the
[portable Chat/Work plan](../superpowers/plans/2026-10-18-portable-chat-work.md).
It preserves original DSH planning and Session ownership. Recovery consumes an
already produced native result; it never repeats inference or starts a task.

## Recovery boundary

The Gateway's authenticated internal attempt route can inspect an exact owned
intent, original run/version and Session. It returns immutable source, original
attempt binding and witness metadata. The checkpoint route can read the exact
historical publication receipt. Neither operation allocates an attempt, extends
a fence, grants execution or returns summary text to a browser. A settled,
already published receipt remains readable after a newer input without treating
that historical receipt as current execution permission.

The adapter's opt-in `ordinaryChatCompactionRecovery` requires original input
admissions, run-history verification and Chat context support. Its bearer-only
`POST /v1/sessions/:id/chat-checkpoint-recovery` accepts only
`{history:{owner_id,conversation_id,run_id,expected_run_version},intent_id}`.
The default is off. This is a trusted maintenance entry, not a public chat tool,
automatic startup hook or replacement scheduler.

Without an existing publication, recovery requires an empty live Session/Agent
registry, a current original source, the exact persisted prefix hash/count and
exactly the original successful four-event compaction tail. It reuses original
input admissions, completion proof, replay invariants and the native checkpoint
evidence validator. Full disk snapshots and current ownership/source are checked
again before original usage settlement and publication. Every opened read handle
is closed. The native log is never rewritten, registered or woken.

Known complete native usage settles only through the original attempt journal.
Reserved/released attempts cannot dispatch, and absent, partial or unknown usage
cannot become a zero charge. Publication still performs its own current-source
transaction. A failed recovery does not imply the model request was free.

## Official replay compatibility

Actual tests against the pinned official SDK exposed two representation issues:

- Its JSONL codec persists an omitted root `delegationDepth` as `0`. Recovery
  reconstructs the omitted form only when the entire original prefix digest
  matches. Nonzero depth and any other changed header or event still fail.
- `Session.create` appends an in-process `session/end-seed` marker to detached
  replay. The complete official replay is validated first. A read-only evidence
  view then exposes the exact durable events, excluding only that verified
  trailing empty marker. Any other extra event fails. The marker is never
  persisted or claimed as part of the original four-event result.

These corrections retain complete prefix hashing and official surface replay;
they do not relax original owner, input, profile, model, coverage or usage checks.

## Acceptance

Unit and Gateway regressions cover metadata-only historical reads, immutable
bindings, disk reopen, no writes, missing/foreign/changed scopes, altered native
prefix/model/usage, partial/error tails, active registries, cancellation, drift,
closed handles and zero-native-IO replay of an existing receipt.

Four actual official Host process-exit cases use an isolated scripted provider:

| Cut | Required outcome |
|---|---|
| Native result durable, before publication | Same-home restart publishes the original result once. |
| Publication committed, before acknowledgement | Restart returns the exact original receipt; repeated reads do not infer. |
| Auxiliary summary stream incomplete | Recovery refuses; unknown cost stays unknown and no checkpoint is created. |
| New original input accepted before recovery | Old publication is refused; the new queued input remains untouched. |

Both successful cuts carry two checkpoint generations through four original
questions: six provider requests are exactly four answers plus two summaries.
The two refusal cuts retain three requests and two answers, without another
attempt or checkpoint. Historical replay is also tested after a new input has
made the original Session live again. These are actual SDK/process tests with
synthetic responses, not live-provider latency, quality or cache evidence.

Final regression passed:

- Gateway: 1,809 total, 1,802 passed, 7 skipped, no failures; build passed.
- Adapter: 688 total, 663 passed, 25 skipped, no failures. The focused recovery
  and original completion suites also passed all 19 cases.
- Root runtime: all 50 tests and the production build passed.
- Official SDK/Host: 18 selected cases passed serially, with no failures or
  skips, including original Work, a budgeted role and historical publication.
- Default Host tests: 16 passed and 82 installed-SDK cases skipped without a
  runtime path. Those skips are not counted as actual SDK acceptance above.
- Release source review: 1,003 files and six scanner regressions passed.

Initial restricted-account attempts encountered local connection and hard-link
permission failures. The complete original root, adapter and Gateway suites were
rerun successfully in the authorized user context; those earlier failures are
kept separately, not relabeled as passes. The release scanner also required a
quiet-tree rerun after temporary test fixtures finished changing.

## Remaining gates

Automatic post-answer starts, hidden Chat maintenance presentation, real-provider
acceptance, UI/standalone integration and general readiness remain separate
unchecked gates. Default profiles and production deployment are unchanged. The
full 26-capability plan remains active; this increment does not complete it.
