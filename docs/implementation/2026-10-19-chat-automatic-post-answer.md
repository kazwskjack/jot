# Automatic maintenance after an original Chat answer

This implements the automatic-start sequence in the
[portable Chat/Work plan](../superpowers/plans/2026-10-18-portable-chat-work.md).
DSH remains the planner and owns native execution. There is no additional task,
periodic scan, model-selection path or background job queue.

## Trigger and authority

Only after the original Worker commits a canonical v2 Chat answer and finalizes
its original run does it schedule a detached best-effort notification. The
foreground lease has already been removed. Delivery cannot block or change the
answer, including when it fails or never settles. Work, legacy context and
rolled-back publication do not trigger this callback.

The Gateway derives the owner, conversation, Session and resulting run version
from original stored records. It reuses the original compaction source reader
before sending only `{history}` to the authenticated adapter's
`POST /v1/sessions/:id/chat-post-answer`. A response acknowledges notification
acceptance only. A browser/model cannot supply a lease, provider, effort or
alternative intent through this entry.

The Host prepares the original immutable intent and inspects its attempt. An
existing attempt always goes through the original checkpoint/receipt recovery;
even an ambiguous or partial prior attempt cannot dispatch new inference. A
fresh attempt requires the original live Chat Agent, empty inbox and official
idle boundary, then calls the existing compaction manager. That manager retains
all current-source, pressure, model, native admission, once-only dispatch,
original usage and checkpoint publication checks. In-flight exact notifications
coalesce; another run cannot inherit their job.

The accepted operation has its own lifetime signal. Closing the notification's
HTTP request does not cancel it. New input still uses the original manager's
owned cancellation/drain hook. Source changes before dispatch refuse the old
operation; new input during a summary drains that original maintenance before
native admission. Shutdown aborts and drains the Host's owned jobs.

Lost notification delivery may skip this optimization. It does not enqueue a
replacement run or repeat a model call. An explicit same-source retry is still
subject to the original immutable attempt/result recovery. Original stored
conversation history is retained if no useful checkpoint is published.

## Configuration and observation

The independent Worker switch is
`GENERAL_AGENT_CHAT_COMPACTION_AUTO_ENABLED=false` by default. Enabling it
requires Chat, original input recovery and steering. The Host independently
requires `ordinaryChatCompactionAuto: true`, original compaction, Chat context
and checkpoint recovery composition. The source must be `checkpoint-text-v2`.
Neither switch changes general readiness or activates a production profile.

The Host emits a non-persistent internal completion observation containing only
original IDs/version, a bounded status/reason and `execution_authorized:false`.
It never contains summary text, raw exceptions, transcripts, model keys or a new
grant. Observer failures cannot change the operation's outcome. This internal
observation is not projected as a public chat activity or another reply.

## Acceptance and remaining work

Unit regressions cover detached acceptance, exact in-flight coalescing, original
recovery, stale/foreign/legacy source rejection, Agent and inbox changes, request
closure, shutdown/drain, strict bearer/body contracts, bounded observations,
post-commit/no-lease sequencing and failed notification isolation. Gateway tests
also preserve the existing immutable native-owner trigger; tests do not disable
it to simulate a mutable identity.

Actual official SDK cases exercise high pressure, low pressure, new input during
the summary stream and new input before source preparation completes. They use
the original Worker callback and trusted client, not a manual request file or a
standalone `compactNow` probe. High pressure produces one useful checkpoint,
exact replay produces no extra model call, and the next original request uses
that summary once. Cancellation preserves unknown usage and publishes no stale
checkpoint. A newer input before preparation prevents inference entirely.
Visible message/activity projections are checked for absence of summary text.

The current regression run completed with 50 root tests, 670 adapter tests
(25 explicitly skipped) and 1,807 Gateway tests (7 explicitly skipped), all
without failures. Root and Gateway production builds completed. The selected
installed-SDK serial suite passed 22 cases with no skips or failures, including
all four automatic-start cases, original Work/role execution and persisted-input
final publication. These cases use a synthetic local model transport: they
prove the installed SDK and original Gateway/Host integration, not live-provider
quality, cache behavior or production readiness.

Public-source review passed for 1,008 files and six scanner regressions. The
staged source and reachable Git history are reviewed separately before upload;
runtime fixtures, transcripts, private diagnostics and deployment configuration
are not part of this increment.
Work's explicit visible compaction presentation, UI/standalone integration,
actual-provider quality/cache/timing and the full capability ledger remain
separate gates. This is not production activation or full Chat readiness.
