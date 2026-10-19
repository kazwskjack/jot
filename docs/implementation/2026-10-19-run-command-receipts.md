# Original command receipts and recoverable stopping

This increment applies to the extended Gateway and its React/BFF interface. It
does not silently replace the standalone root `/api` protocol, add a scheduler,
change DSH planning, or enable production execution switches.

## Original business and HTTP receipt share one commit

Completed HTTP replies already had a response cache. The uncovered failure was
between original steer/cancel business commit and that cache write. In the new
tests, a SQLite trigger rejects the successful response-receipt write. Before
the fix, a command remained committed despite the failed receipt.

With the configured authenticated/CSRF/idempotency request boundary enabled,
new `/runs/:id/steer` and `/runs/:id/cancel` reservations use
`run-command-atomic-v1`. Existing business guards, command insertion, cancellation
state/events, response contract validation and the original HTTP response receipt
now use the existing immediate SQLite transaction. A failed receipt rolls those
writes back together. Explicit exact retry may complete that known atomic
reservation; an old pending reservation without this protocol still refuses.
Completed original receipts replay before mutable run-version checks, including
after database reopen. Changed bodies and foreign owners cannot borrow them.
An accepted receipt is not proof of native input execution or task completion.

Cancellation's direct service row read also moved inside its existing write lock.
Competing committed owner/state/version updates are observed before mutation.
The original native Dispatcher, its custody/admission proofs, task/role guards,
cancel priority and unknown-outcome handling remain authoritative.

## Stop retry in the actual interface

The UI freezes an original cancel path, expected version, body and key before
transport. It validates the accepted response's original run and command identity
before clearing that receipt. Network failures, 5xx, malformed success and
`IDEMPOTENCY_IN_PROGRESS` remain unconfirmed. A dedicated retry button stays
available even if SSE has already shown a terminal run and the ordinary stop
button disappeared. Retrying cannot select another run or increment its version
again. Definite rejection permits an owned refresh; it never automatically sends
another cancellation against a newer version.

A mismatched task/conversation identity in the fresh status read refuses before
any cancellation is sent. Draft text is retained. While cancellation is unknown, replacement sends,
settings, uploads, voice input, interactions and native Goal controls are blocked;
read-only output viewing is unchanged. The conversation's back button is blocked
and browser departure warns. This is mounted-conversation memory, **not durable
browser command recovery after forced reload/remount**. Server receipts persist.
The task's actual state still comes from original snapshots/events; a 202 does
not fabricate a "stopped" native status.

Ordinary message sending now also keeps `IDEMPOTENCY_IN_PROGRESS` pending and
checks the original conversation plus complete MessageReceipt identity before
clearing its original input. Malformed success cannot silently clear the draft
receipt. Existing text/file references and retry keys remain frozen.

## Executed evidence and remaining scope

Nine focused backend cases pass: atomic response-write failure for both commands,
exact reopen/replay, changed-body and foreign-owner rejection, legacy unknown
reservation refusal, and competing cancellation/steering SQL acquisition updates.
Controller/cancel helper tests cover original request replay, malformed identity,
known rejection and pending server reservations.

The mobile test uses actual React, the original BFF and Gateway HTTP/SQLite/SSE.
An ambiguous response is injected after real queued cancellation commits. SSE
becomes terminal; the UI then retries the exact original body/key, shows one
command and one version increment, and retains its draft. This browser regression
failed before the explicit retry UI was implemented and then passed.

A separate actual installed-SDK mobile case stops a running original task through
the original Dispatcher and Session client. It observes one native cancel call,
one original run in cancelled state, an applied command and zero canonical final
answers. Its model endpoint is a scripted local fixture, not an external provider.
The full Gateway suite passed 1,832 tests with seven explicitly gated skips and
no failures; UI passed 237 and root passed 67, both without skips. Typecheck,
Gateway build and Windows Vite build passed. Actual installed-SDK serial Chat
regression passed 21 cases and the selected original Work compaction case passed,
all without skips. A final focused mobile rerun covers normal streaming plus
native cancellation after the original-target identity guard. Privacy/release
audits remain separate from these local scripted-provider facts.

**Still open:** active UI text sends currently queue another conversation input;
they are not yet connected to live original steering. Before changing that label
and path, verify trusted Worker/admission readiness and preserve the original
fallback prohibition even across switch rollback. Native steering is text-only;
attachment continuation requires a coordinated versioned content/admission path,
not a filename pasted into text or discarded uploads. Those portable acceptance
gates, external-provider/billing tests and the original 26-capability ledger remain
unfinished.
