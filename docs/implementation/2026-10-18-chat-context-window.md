# Bounded Chat context through original native admission

This increment implements task 4's ordered text window for the extended
Gateway and the original Session adapter. It does not enable general Chat
readiness, change Work execution, or complete the full capability ledger.

## Acceptance and source integrity

The original input transaction freezes `recent-text-v1` before inserting the
current human message. It selects at most twelve previous complete user or
assistant messages in canonical publication order. The model-facing string,
including its framing and JSON, is at most 14,000 UTF-16 code units. Each user
excerpt is at most 4,000 and each assistant excerpt at most 2,400 code units;
truncation does not end on a high surrogate. Newer excerpts take precedence.
These are history selection bounds, not a billing or current-input token cap.

Only text blocks enter the seed. Raw reasoning, structured tool bodies,
attachment bytes and inline image data URLs do not. The current original
message and its attachment admission are unchanged. Image interpretation and
image-result archival remain separate, on-demand capabilities.

Each source retains its message/run identity, creation/update metadata,
content SHA-256, original text size and truncation/image-omission indicators.
The snapshot retains conversation version and context policy revision. Its
canonical JSON and digest are stored on the accepted run with an immutable
database trigger. An idempotent input retry reuses that run and exact snapshot;
later source edits cannot change it. Original messages are not rewritten or
deleted. Migration adds nullable fields without inventing seeds for old runs.

The bearer-only internal `ordinary-chat-context` reader requires the original
run, Session and live execution lease. It rechecks policy, snapshot schema,
hash, version, revision and exclusion of the current message. It is read-only
and returns `execution_authorized: false`. Its authority is not a substitute
for original input admission, permissions or cancellation.

## Official Session integration

The optional `ordinaryChatContext: true` adapter setting requires trusted
`ordinaryExecutionPolicy`, original model selection and input admission.
Generated profiles leave it off. Work Sessions make no context bridge call.

The adapter reads the frozen snapshot before the original pre-step enters,
under the original authority and cancellation fence. It uses the official
Session append-only surface API, not mutation of frozen model options or a
replacement native human input:

- On a fresh Session, the original driver commits its system prompt first,
  then the bounded context message, then the exact original human input.
- On later accepted inputs, a logged surface replacement retains the leading
  native system messages and replaces only the old conversation body. The
  underlying raw transcript remains stored.
- The context marker records original run/policy/context digests and source
  references. A retry or reopen validates and reuses that exact marker; it does
  not append another copy. A failed flush must succeed before entry. A later
  request in the same run does not start a new request series.
- Foreign identities, altered markers, unexpected system-prefix layout,
  expired leases or cancellation prevent entry. A late bridge/flush completion
  after cancellation cannot admit an inference.

An initial actual-Host test exposed a prefix-order bug: committing the first
context before the native driver hid the expected leading system prompt. The
implementation was changed to the first-batch/body-only sequence above; the
original system-prefix assertion was retained and now passes.

## Verification

All model transports in these tests are local scripted fixtures. No user
conversation, provider key or production endpoint is required.

| Gate | Result |
| --- | --- |
| Final context/migration/internal-route focused suite | 6 passed, 0 skipped |
| Session adapter full suite | 604 passed, 25 conditional skips, 0 failed |
| Actual installed SDK suite | 9 passed, 0 skipped |
| Selected actual official Host chains | 4 passed, 0 skipped |
| Standalone root regression | 50 passed, 0 skipped |
| Root Windows build | Passed |
| Gateway Windows build | Passed |
| Gateway full regression | 1,765 passed, 7 conditional skips, 0 failed |

The four Host chains cover the original Chat path, bounded two-turn Chat,
ordinary Work and a saved role. The bounded test inserts forty old synthetic
messages, changes a source after acceptance, checks the exact frozen window,
excludes reasoning/image bytes, and observes identical system prompts and Web
schemas across both actual requests. It verifies one model call and one
canonical answer per input, original transcript preservation and no extra
human RPC. This proves stable prefix construction, not a provider cache hit.

The SDK reopen test combines actual official Session persistence with a real
Gateway replacement lease. It proves no second context append after reopen.
It is not a full cold Controller inference test. Separate existing actual SDK
cases cover original input recovery, model policy and forced Host exit.

The six-test focused rerun includes a disk migration/reopen assertion added
after the full Gateway run began. It is reported separately, not added to that
run's total.

## Still open

Durable per-native-turn Search/Fetch allowances and failed-URL replay handling,
post-answer-only compaction with cancellation/accounting, actual provider cache
metrics, real Host readiness/activation, the UI mode/default and the separate
standalone contract remain open. No universal speed, live search quality,
production rollout or full 26-capability completion is claimed here.
