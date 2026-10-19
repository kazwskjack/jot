# Chat native readiness and timed answer streaming

This increment connects the actual extended React interface through the original
local BFF, Gateway, Worker and pinned installed DSH SDK. It retains all original
owner, CSRF/origin, input admission, execution policy, lease and publication
checks. The standalone root Chat executor remains a separate supported profile.

## Configured native readiness

The Session client already called `/v1/conversation-modes/readiness`, but the
adapter did not implement that route. Earlier UI/native tests explicitly used
readiness fixtures. Combining the actual layers revealed the missing boundary.

The adapter now has an internally bearer-authenticated POST read accepting only
an empty object. Other methods and configuration-bearing bodies refuse before
reading readiness. It defaults to `{protocol: 1, ready: false, policy: null}`.

Trusted Host configuration may explicitly set `ordinaryChatModeReadiness: true`
only alongside all of the following:

- An exact accepted `ordinaryExecutionPolicy` for Chat with thinking disabled.
- A mounted `jotChatPresetReady` service whose preset ID and revision match that
  policy. The adapter plugin must declare that service dependency when enabled.
- Original `ordinaryModelSelection` and original input admission composition.
- `ordinaryChatContext: true` and `ordinaryChatWeb: true`, retaining the existing
  bounded seed and durable read-only tool allowances.

Invalid explicit enablement fails startup. The returned policy is detached from
configuration and from other callers' responses. This read cannot activate a
Session, grant execution, authenticate an external provider or change a model.
Background post-answer maintenance retains its independent opt-in switches and
all original guards. No production switch is enabled by adding the endpoint.

## Short initial text must not wait for completion

The original Runner accumulated short chunks until a size threshold, checking
elapsed time only when another chunk arrived. A single short initial chunk could
therefore remain invisible for the entire wait before model completion.

The Runner now schedules an actual flush at its configured delta interval
(250 ms by default), retaining size-triggered batching and separate block/kind
identities. Timer- and event-triggered projections share one serial queue so a
slow downstream callback cannot duplicate indexes, interleave writes or lose
text. The final native message still establishes final content and the original
completion proof/publication remains authoritative.

Timer failures abort the original observer and surface through normal failure
handling. Cancellation stops new flushes; every exit clears the timer and drains
owned projections. Partial text is never converted to a canonical final answer.
This improves transport presentation, not provider reasoning speed or billing.

## Executed evidence and remaining gates

The held-stream regression first failed with zero visible deltas before release.
Four flush regressions now cover early short text, delayed concurrent timer/size
flushes with distinct indexes, cancellation and projection failure. Together with
existing Runner/preparation cases, 50 focused tests pass without skips.

Two readiness tests cover default-off behavior, detached results, invalid
prerequisites, matching revisions, strict bodies/methods and bearer authentication.
The final adapter regression passed 672 tests with 25 explicit gated skips and
no failures. Root tests passed 67 and UI tests passed 233, both without skips.
Typecheck, Gateway build and the Windows Vite build passed.

The actual mobile browser case creates and sends through the original BFF and
Gateway with actual adapter readiness/catalog reads, SQLite, original Worker and
installed `0.2.1-rc.2` SDK. A scripted local Messages provider holds its final
events after initial text. The UI displays that text while the canonical answer
count is zero and mode switching is disabled; releasing the stream commits one
answer, and reload/reopening the same owned conversation shows that answer once.
The test uses the conversation's current title because normal first-message
title generation changes the initial title. Test cleanup explicitly closes its
own HTTP/SSE sockets; it does not modify production shutdown or user sessions.
The focused complete case passes, including cleanup.

The installed-SDK serial Chat regression passed 20 cases without skips, and
the separately selected original native Work compaction case passed. The complete Gateway regression passed 1,826 cases, with seven explicit
gated skips and no failures. Source/staged/history audits are reviewed separately
before explicit feature-branch publication. This local scripted provider does not
prove actual external Search/Fetch, provider quality, first-token latency/cache
benefit, external billing or production activation. The complete portable gate
still includes UI steering, uncertain sends, attachments and external-provider
acceptance; the full 26-capability ledger remains open.
