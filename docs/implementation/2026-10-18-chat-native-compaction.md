# Original Chat compaction engine and input cancellation

This increment connects the pinned official `BasicCompactionEngine` to the
original completed Chat Session. It implements the execution/cancellation
prerequisite, not automatic background scheduling or general Chat readiness.
Generated profiles remain unchanged. Useful checkpoint consumption, UI filtering
and live-provider acceptance still gate activation.

## Native composition

The optional `chat-native-compaction-v1` preset retains the original Chat
persona and read-only Web tools. Its compaction service has an isolated realm,
following the official preset registry contract. Work keeps its full existing
official composition.

`chat-maintenance-runtime.mjs` provides the Host-local ownership registry as an
independent root plugin. The optional preset depends on that service explicitly;
it must not provide a service while also awaiting a child that injects it.
The actual SDK initially exposed that dependency cycle, then rejected an
unisolated compaction service. Both startup failures were corrected without
extending readiness deadlines or changing official runtime code.

The manager obtains the original Agent's isolated engine through the official
`agentPresets.serviceFor(agent, 'compaction')` API. Root `agent.ctx.get` does not
resolve an isolated preset service. Cordis returns context-bound service proxies;
repeated reads may have different proxy references. A stable, immutable,
Host-local engine identity verifies continuity across those reads. It is not
execution authority or a user-controlled model identifier.

## Execution and accounting

`ordinaryChatCompaction: true` is an explicit Host-only composition option. It
requires original Chat policy/context, completed-source/native observation,
immutable admissions, the actual token meter and original model metadata.
The manager exposes no browser start endpoint and installs no timer or automatic
worker trigger. Only isolated tests currently request an execution.

Each request rechecks its exact owner/conversation/run/version/Session and
immutable intent. It observes the original completed native answer, measures
effective pressure using the actual engine policy, checks native proof again,
and binds its own operation before invoking inherited `compactNow`.
Low, unknown or changed pressure skips without inference.

The engine subclass overrides only the supported `summarize` hook.
`auto: false` disables foreground automatic compaction. The inherited engine
retains native maintenance ownership, range selection, shrink/stability checks,
standalone start/end markers, summary framing, adjacent replacement and flush.
The summary request preserves the official system/tools/history prefix, adds a
fixed trailing instruction, and explicitly sets reasoning effort to `off` and
purpose to `compaction`. A truncated, failed, nontext or empty result cannot
become a successful checkpoint.

The existing independent stream journal reserves and records one-time dispatch
before inference. It settles actual terminal usage before releasing a successful
finish. Incomplete cancelled streams retain unknown usage, never a successful
zero. New input and source revocation do not erase incurred usage. There is no
replacement conversation, planner, foreground lease or second user-facing answer.

## New input and cancellation

Before original native input admission, the existing authority and replay-profile
checks run first. Only a valid input can cancel the same Session's owned
background operation. The hook aborts that operation's own signal and awaits its
native maintenance cleanup; it never calls `Agent.cancel` on another activity.
Authority is checked again after the wait. The existing native message,
attachment, steering, lease and idempotency logic then continues unchanged.

Actual inbox insertion also aborts matching owned maintenance. Disposal aborts
and drains only this manager's operations. User cancellation and source drift
still suppress stale summaries while preserving accounting evidence.

## Evidence and limitations

Actual pinned SDK tests run through the official launcher, real Gateway/Worker,
original Session and a local scripted Messages provider:

- High effective pressure: two original answers plus one summary request;
  three model calls, two canonical answers, eleven settled auxiliary tokens.
  Native start/summary/adjacent replacement/end records flush and replay through
  official `Session.create`. System/tools prefix remains unchanged and the
  actual summary request disables thinking despite the global high default.
- Low pressure: two calls, two answers, no compaction events or attempt row.
- A third question during the live auxiliary SSE stream: own compaction is
  cancelled and drained, then the original question succeeds. Four total calls,
  three canonical answers, start/end failure markers, no summary replacement,
  and an independently retained `usage_unknown` attempt.

These are actual SDK/local synthetic-provider tests, not measured production
cost, speed, cache hit rate or provider quality. The earlier startup failures
and fixture ID/replay corrections are not counted as passing runs.

The Gateway does not yet publish an owner checkpoint from the native summary,
and the current bounded next-question seed does not consume one. Automatic
starts therefore remain absent: running summaries that the next seed discards
would waste tokens. Checkpoint source/span/generation/hash verification and
versioned next-request consumption are the next implementation step. Chat-only
activity filtering, restart/recovery gates, UI/standalone integration and the
full capability ledger remain open.

## Release regression

The final selected official Host run passed eleven distinct cases serially with
zero failures/skips. Full adapter regression passed 653 tests with 25 conditional
skips and zero failures. Root regression passed all fifty tests; the local
Windows build passed. Restricted-context root tests initially failed on local
loopback access; the complete user-context rerun passed. Gateway source is
unchanged in this increment; its earlier full-suite evidence is not relabeled
as a new run.

Six public scanner tests pass and 986 source files were scanned. Staged private
endpoint/identity patterns have zero matches. The reachable-history audit retains
seven unchanged previously reviewed findings: two generic example-path documents
and five neutral Office blobs. These are not an automated zero-finding result;
no new finding was introduced. Runtime data, logs, credentials and local model
fixture databases are excluded from publication.
