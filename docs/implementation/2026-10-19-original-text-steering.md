# Original-task text supplementation

This increment connects ordinary Chat/Work conversation text supplementation to
the existing owning Worker, Dispatcher and native Session. DSH remains the sole
planner. Role conversations retain their separate existing message behavior.
It does not enable production switches or close the full capability ledger.

## API and custody

`SteerRequest.delivery` optionally accepts `original`. Legacy omitted requests
retain the existing behavior. The stronger request requires the trusted API and
owning Worker steering/recovery configuration. `/capabilities` reports configured
support, not the health or readiness of a particular Worker. Configure both API
and owning Worker with `GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED=true` and
`GENERAL_AGENT_ORDINARY_STEERING_ENABLED=true` only after draining incompatible
in-flight consumers and checking the original native readiness prerequisites.
The checked-in defaults remain false. Capability advertisement cannot authorize
native execution or replace admission checks.

The API retains the existing three-field native text payload. It reserves the
existing immutable original-command custody against saved Session identity and
the current original Worker lease within the same transaction as the command and
HTTP response receipt. No browser-provided Session, lease or owner is trusted.
Expired/missing/foreign/not-running/role/Goal scope refuses without retaining the
command. Receipt failure rolls command and custody back together. The HTTP
request hash includes delivery metadata. The existing native proof stays exact.

Custody prohibits a fresh-run fallback even after configuration rollback or
terminal original state; a pinned earlier Dispatcher is refused by the existing
SQL guard. Custody and HTTP acceptance do not prove native delivery. The owning
Dispatcher must still validate its original readiness, admission and binding.

## Interface and recovery

Ordinary active-task sends use the original steer route rather than queueing a
new conversation input. They freeze the run, version, body and key before I/O.
An unknown response retries that same request after mutable task state changes.
Malformed success, transport/5xx and pending HTTP reservations do not erase it.
Definite rejection refreshes owned state without automatically rebasing/resending.
Non-running or unconfigured scope preserves the draft and explains unavailability.

Pending receipt controls block conflicting mutation, Goal and Stop controls;
browser departure warns. This is current mounted-page recovery, not a claim of
durable browser recovery across forced reload. Server custody and receipts are
durable. Actual original message events establish native delivery.

Attachments are retained and explicitly refused for active text supplementation.
Image/file continuation remains a required separate versioned content/admission
boundary; no upload is silently dropped or represented as recognized text.

## Verification

- Real API/SQLite fault injection rolls back both custody and command if the
  successful HTTP receipt cannot commit. Exact retry/reopen and flag rollback
  retain one original command; the pinned earlier Dispatcher cannot create a run.
- Controller tests freeze original identity across terminal state, malformed
  identity, pending reservation and capability changes; unsupported scope or
  attachments cannot manufacture another conversation message.
- Actual mobile React + original BFF/Gateway HTTP/SQLite/SSE test injects a lost
  reply after commit and a terminal state. Exact UI retry retains one original
  run/command/custody and no fabricated supplement message.
- Actual installed DSH SDK test sends through the same mobile UI, original API,
  owning Worker/Dispatcher and native admission. The local scripted provider
  observes the supplement in the original native tool sequence and one final
  answer for the original run. A second independent question verifies its own
  Web allowance. This is local composition evidence, not external model quality.

Final Windows verification: Gateway 1,841 passed, seven explicit skips, zero
failures; root 67 and UI 243 passed without skips. Installed SDK Chat serial
regression passed 22 and the selected original Work compaction case passed one,
all without skips. Gateway typecheck/build and root Vite build passed. The seven
Gateway skips are the POSIX mode/ownership case, five optional Python/Office
cases and the opt-in large-output competing-writer measurement; they are not
counted as passing acceptance.

Source/privacy scanner tests passed six and reviewed 1,050 source files. Git
history findings matched the same seven previously reviewed objects with no new
findings; staged private-identity patterns matched zero. Only the explicit
reviewed source, tests, contracts and documentation enter this feature-branch
increment. No provider credentials, conversation data or deployment identity
belong in the release. This is local composition evidence, not production or
complete 26-capability acceptance.
