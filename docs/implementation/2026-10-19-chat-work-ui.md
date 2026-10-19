# Chat and Work in the extended conversation UI

This increment connects the existing extended Gateway mode protocol to the
React workbench. It does not introduce a planner, change a native Session or
turn on Chat readiness. The standalone runtime remains a separate profile.

## Behavior

An ordinary conversation shows one italic, bold `chat` or `work` control.
Tapping it requests the other mode through the existing versioned conversation
endpoint. Active runs, pending sends, attachments, voice capture and uncertain
mutations prevent switching. The server still enforces owner, native idle and
Goal constraints; the UI is not an execution authority.

Chat hides model, reasoning-effort and Goal controls. The focused composer keeps
its text and actions on one row; multiline text can grow, and attachment chips
have their own row. Work retains its existing model and Goal controls. Switching
preserves the unsent draft. Effective Chat model and reasoning policy come from
the accepted server policy, not the hidden stored Work model preference.

The conversation list now creates a conversation using a returned writable
workspace and actual model catalog. It requests the advertised default mode.
Chat is used only when that default has confirmed readiness. Unavailable Chat
is shown explicitly, with Work as the available default. An older capability
response without mode support keeps the legacy request without a mode field.
Missing workspace/model data or malformed capabilities cannot invent a setup.

## Uncertain outcomes and concurrent edits

Creation and mode changes reuse the original mutation-receipt implementation.
A network error, ambiguous proxy response or malformed success retains the exact
path, payload, expected version and idempotency key. Only an explicit retry sends
that original command. A response must match the original identity, mode and
version before it clears the receipt. The picker blocks replacement creation
and navigation while its outcome is uncertain; the conversation blocks sending,
mode/model replacement and in-app departure while the mode outcome is unknown.

A definite version conflict refreshes the owned conversation. It never retries
a mutation automatically. Stale snapshots cannot replace a newer confirmed
conversation version. Reload after a confirmed mutation reads the saved mode.
Unknown receipts in this increment are held by the current page with a departure
warning, not a new durable recovery store. Native Goal's separate durable intent
protocol is unchanged.

## Verification and limits

Five helper tests cover readiness, actual configuration, legacy requests,
uncertain response identity, immutable retry and definite conflict behavior.
The browser case renders the actual React picker/conversation and entry CSS at
a mobile touch viewport against original Gateway routes, SQLite and event replay.
It covers:

- Creation committed before a synthetic ambiguous proxy response, explicit exact
  retry, and one resulting database row.
- Mode update committed before an ambiguous response, blocked editing until
  retry, exact original key/body, and preserved draft.
- Hidden Chat controls, focused single-row layout, Work controls and Goal menu.
- Saved mode after reload, an actual competing-client CAS conflict followed by
  a read refresh without automatic mutation replay, and explicit next switching.
- Mode changes disabled during an accepted queued run, unavailable Chat and
  compatibility with a legacy capability response.

The fixture explicitly supplies native readiness and idle responses. It does
not run a model, test provider speed, perform ASR, or prove the complete
React/API/installed-SDK acceptance gate. Existing independent composer, upload,
voice and Goal suites remain separate regression evidence. This release does
not enable production Chat or complete the full capability plan.

Final local regression: 229 UI tests passed with no skips, including the mobile
case above; all 50 standalone root tests passed, and the Windows Vite build
passed. The layout assertion was also run against the previous two-row layout
with the actual entry CSS and failed before restoring the fix. Gateway runtime
and native Host code are unchanged in this increment; their earlier separate
test results are not represented as a new end-to-end model run here.
