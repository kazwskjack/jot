# Native Work compaction activity

This increment implements the explicit Work presentation sequence in the
[portable Chat/Work plan](../superpowers/plans/2026-10-18-portable-chat-work.md).
DSH owns the compaction trigger, engine, native history and summarization. The
Gateway projects lifecycle metadata; it does not start a summary or replace
native history.

## Original authority and compatibility

`GENERAL_AGENT_WORK_COMPACTION_PROJECTION_ENABLED=false` remains the default.
Opt in only with the paired updated activity contracts and UI. Invalid boolean
configuration fails at startup. The Runner requires the original accepted
execution policy to say Work. Missing/legacy policy and Chat produce no public
compaction activity, even with the flag enabled; the browser cannot supply this
policy. Chat background maintenance remains quiet.

The new `Activity_compaction` variant is explicit in OpenAPI JSON/YAML, the event
schema and both checked-in TypeScript consumers. It does not have a fabricated
`tool_call_id`. Older strict activity consumers must be upgraded before a
producer enables this variant. This flag does not enable general readiness,
change task permissions or activate a production profile.

## Native events and visible states

The projector pairs the official `compaction/start` and `compaction/end` by
native compaction identity within the original run. It derives a bounded activity
identity from both values, preserves the observed start time, rejects malformed
identities and ignores duplicate or unmatched ends. A late duplicate start
cannot reopen a terminal activity. A native error becomes a fixed failed state;
raw error strings are not returned.

Only phase, status, time and bounded identity metadata enter the activity event.
`compaction/summary`, summary/raw-output bodies and model/provider fields are not
projected. The event store and original snapshot/replay path retain one activity
per native operation without another assistant answer.

The actual React conversation renders fixed running, successful, failed,
cancelled and unknown labels. If the original run ends without a matching native
end, the UI shows unknown (or cancelled for a cancelled run). Finishing a run
never invents successful compaction. Ordinary tool activities keep their existing
rendering behavior.

## Current evidence and remaining gates

The contract/Runner tests use the real Worker, event store and snapshot/replay
code, alongside deliberately synthetic native frames. They cover original Work
policy versus Chat/missing/disabled policy, bounded metadata, duplicates,
unmatched ends, invalid identities and strict rejection of extra summary/tool
fields. The initial full regression found an omitted checked-in contract type;
that consumer was synchronized, and the corrected focused contract set passed
47 tests. The corrected final full Gateway run passed 1,813 tests, skipped seven
explicitly gated cases and had no failures.

The React component tests cover fixed labels and unfinished terminal runs. A
real browser test uses the actual React/controller/SSE path in a mobile viewport,
reloads during and after the operation, replays duplicate events and checks that
private summary markers remain absent. Its native frames are explicitly synthetic.
The complete UI set passed 223 tests, the root set passed 50 tests, the root build
completed and Gateway typechecking passed.

An additional installed official SDK case exercises the original Work preset,
real Gateway and original Worker. Its test-only preset reads the installed
standard declaration and changes the retention budget to 64 tokens so a small
fixture is genuinely compactable; automatic pressure triggering and the native
engine remain official. A scripted local Messages endpoint supplies original
high-effort answers and one summary. Three model requests yield two original
answers and one successful activity with a real native start/summary/end pair;
the next original request consumes the summary, while no summary enters the
visible answers. This proves native producer integration with the pinned SDK,
not actual-provider quality or production timing. Product defaults are unchanged.

The selected installed-SDK serial regression passed 23 cases with no skips or
failures. After that run, the Work case added stronger assertions over every
persisted visible assistant/activity/message event and exactly one next-request
summary marker; its focused rerun also passed. No product runtime changed between
these runs. Gateway build and public-source/history review are completed before
publication; heuristic history findings require explicit review rather than an
automated zero-findings claim.
The complete Chat/Work interface, standalone profile, actual-provider/cache
measurements and original 26-capability ledger remain independent unfinished
gates. This increment is not a claim of complete product parity or production
activation.
