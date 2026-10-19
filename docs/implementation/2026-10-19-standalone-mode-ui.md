# Standalone Chat/Work interface

The root React application now uses the standalone `/api` mode contract. This
does not replace the extended Gateway/DSH conversation interface or its planner.

## Behavior and command receipts

The header shows one italic mode label. Tapping it requests the other mode with
the currently confirmed conversation version. Draft text stays intact. A queued,
running or approval-waiting task prevents a mode change. An unconfirmed input,
file upload or setting request also blocks switching. Server-side transaction
checks remain authoritative if another client changes the conversation.

New conversations follow actual capabilities: Chat only when its configured
executor is ready, otherwise Work. Legacy capability documents omit the explicit
mode and keep Work creation. A persisted Chat conversation whose route becomes
unavailable cannot send through Work implicitly; the user can explicitly switch
it to Work. The root composer already has no model/effort controls; none were
invented for this change. Existing material and the single-row composer remain.

Creation and mode changes accept an optional `request_id`. A private SQLite
receipt commits atomically with the original change, binding command kind and
normalized intent to its original result. An exact retry restores that result
before current readiness/version/active-run checks, without another change.
Reusing a key for another target, body or command kind refuses. Old callers
without command IDs retain their original behavior. This database belongs to
the existing single-user local server; it is not an extended owner namespace.

The browser retains one in-flight setting command in memory. A transport failure,
5xx response or malformed successful result stays unconfirmed. Navigation,
editing and replacement setting commands are blocked; the explicit retry sends
the original path, body and key. Definite rejection clears the command and reads
current state without automatically repeating the mutation. Snapshot settings
versions are merged independently from event cursors, so older snapshots cannot
overwrite a newer confirmed mode.

**Limit:** unknown client command recovery lasts only while this page remains
open. Closing/reloading warns while a setting is unconfirmed; browser memory is
not durable recovery. Server receipts survive restart, but the UI does not claim
to restore a lost client key after a forced reload. Confirmed mode reload works.

## Executed verification

- Three new runtime tests cover file-backed receipt reopen, exact retries after
  readiness changes, active-run replay, conflicts, rejected mutations and the
  actual optional-ID API with legacy Work creation.
- Three helper tests cover capability interpretation, exact retry identity,
  malformed successful replies and independent snapshot version/cursor merging.
- One mobile browser test uses the actual React entry point, original Fastify
  API, real SQLite, SSE and a local streamed model endpoint. It injects ambiguous
  503 responses *after* real creation and mode commits, verifies unchanged retry
  requests and one effect, preserves a draft, reloads confirmed mode, exercises
  a competing client's version conflict, disables switching during streaming,
  observes partial text before completion and verifies one committed answer.
  Restarting with Chat disabled preserves unavailable Chat and creates new Work.
  The model receives thinking disabled; no Work provider call occurs.
- This test exposed a real React effect cleanup failure after streamed text:
  the scroll effect returned the browser's `scrollIntoView` result. Its block
  body now returns nothing, preventing React from treating that result as a
  cleanup function. The same full browser scenario then passed.

The full root suite passes 67 tests and the UI suite passes 233, with no failures
or skips. Windows local build passes. The provider is a scripted local streaming
fixture: this proves transport/UI composition, not external provider speed,
cache behavior or live monetary accounting. No production deployment is enabled
by this change. External-provider acceptance, extended React/API/installed-SDK
composition and the full parent capability ledger remain separate open gates.
