# Original live conversation commands

Continue the already approved portable Chat/Work and native composition plans.
User intent is to supplement the currently running task immediately. Preserve
DSH as sole planner, original owner/permissions/leases and command admission.

## 1. Atomic original command receipts

`server.ts` already caches completed HTTP responses. The missing boundary is a
crash after the steer/cancel transaction but before its response cache commits.
Reuse the existing `atomicCommand`/`ga_idempotency` protocol on these two routes;
do not add another command store or infer success from mutable run state.

- First add real API tests injecting a response-receipt SQL failure. Assert
  command, cancel state and events roll back together; exact retry may complete
  only a new reserved atomic request. Cover disk reopen, changed body, foreign
  owner and old unknown rows without the new protocol. Old unknown rows refuse.
- Add the two routes to a dedicated receipt protocol and execute original
  business guards, command writes, contract validation and response receipt in
  one existing immediate transaction. Move direct cancel's row read under its
  write lock and test competing owner/status/version changes.
- Preserve existing completed-response replay, original Dispatcher custody and
  native checks. A receipt acknowledges command acceptance, not native execution
  or final success. No fresh-run fallback is introduced.

## 2. Current-page text steering and cancellation

`RoleChatController.send` currently always submits another conversation message,
and the UI labels active submission as queueing. Route an explicit ordinary
active-task text supplement through the existing `/runs/:id/steer` contract.
Freeze original target, body, expected version and idempotency key before I/O.
Unknown responses retry the original command even after mutable state changes.
Keep `IDEMPOTENCY_IN_PROGRESS`, timeout, malformed successful identity and 5xx
outcomes pending. Definite refusal refreshes current owned state without replay.

Add a separate immutable current-page cancel command; the existing UI currently
generates another key when retrying cancellation. Prevent conflicting pending
settings/actions and retain draft text. Do not persist these browser commands
under an invented owner namespace. Keep existing departure warnings and expose
the current-page limitation honestly. Original Role/Goal flows remain distinct.

First test controller behavior, then actual mobile React/API transitions with
ambiguous replies. Finally use original BFF/Gateway/Worker/Dispatcher/installed
SDK for live supplementation and cancellation, observing actual command receipts
and one final answer rather than creating another conversation/run.

### Text delivery implementation boundary

Use an optional `delivery: "original"` in the existing SteerRequest. Legacy
omitted requests keep their existing contract. A trusted API opt-in shares the
original Worker's steering/recovery prerequisites; capabilities report configured
support, not invented Worker liveness. New UI ordinary active-task sends request
that explicit delivery and never silently fall back to a new conversation input.

Inside the already atomic original command callback, strip only that delivery
metadata from the existing three-field native command payload. Then reserve the
existing `reserveOrdinarySteeringCustody` against the original saved Session and
current Worker lease. Its original-input scope checks and existing SQL rollback
guards remain authoritative. Missing/foreign/expired/not-running scope rolls the
command back. The HTTP request hash still includes delivery, so a cached legacy
request cannot masquerade as original-only delivery. No new custody store or
native admission version is needed for this text metadata.

Test acceptance-time custody, exact lost-receipt recovery, flag rollback and the
pinned earlier Dispatcher's forbidden new-run fallback. Native execution must
still use the original owning Worker's ready path and admission checks. UI
acceptance only means a command is retained for that original task; actual
message events establish native delivery. Attachments remain a separate versioned
contract rather than a hidden text conversion.


## 3. Attachment continuation is a separate required boundary

Current SteerRequest, Dispatcher, native steering transport and immutable source
proofs are text-only. Do not serialize a file reference into text and claim an
image was seen, drop an upload, or call this full attachment continuation.
Inspect official pinned content-part support, then version/extend the original
admission/content manifest, resolver and native projections together. Preserve
owner/artifact version/hash and original command identity. The full portable gate
remains open until actual file/image cases and unknown receipt recovery pass.

### Attachment implementation sequence and actual SDK findings

The installed SDK separates encoded input images from durable normalized image
references (`dsh-attachment`), and file bytes remain verbatim content-addressed
objects. Provider assembly projects files to read-on-demand handles; text-only
routes project images to explicit placeholders. Neither projection proves that
a model has visually recognized the image. Do not bypass these original rules.

1. Extend the existing AttachmentResolver with an explicit protocol-1 immutable
   manifest for the original accepted command. Pin owned conversation-scoped
   artifact ID, exact version, size, hash, media type, display name and kind.
   Retry resolves that version, never `current_version`. Keep server paths out
   of this serializable manifest. Reuse existing artifact cleanup leases.
2. Before staging, verify the exact retained version's disk bytes and descriptor
   identity, path boundaries and cancellation. Perform large file reads/hashing
   outside the SQLite write lock, then revalidate the original metadata and
   ownership in its existing transaction before renewing leases. Do not use the
   resulting local path as proof against later reopening/races: the staging
   consumer must retain a verified immutable byte source.
3. Extend original command payload, custody source, native content preparation,
   SessionControllerClient/Dispatcher and Adapter admission together. Files use
   official staged receipts; images use official normalization. Bind both the
   product source manifest and the actual normalized native message. Do not
   weaken protocol-3 text hashes or accept mixed content under old admission.
   New content requires an explicitly versioned protocol and readiness gate.
4. Update original cold-input recovery, immutable admission, completion/history
   and replay consumers for that protocol. Unknown or old consumers must refuse;
   custody must prohibit fresh-run fallback throughout rollback. A raw file
   receipt or source filename cannot substitute for byte/source proof.
5. Only then advertise attachment supplementation and let the existing UI send
   its retained upload references. Test file-only, mixed text/image/file,
   changed current version, corrupted or missing bytes, cross-owner rejection,
   cancellation, lost HTTP/native receipts and cold recovery. Use actual mobile
   BFF/Gateway/owning Worker/Dispatcher/installed SDK, one original run and one
   final answer. Model-specific vision/quality remains a separate real-provider
   gate. File handles alone do not count as read or image understanding.

The resolver prerequisite alone does not enable or complete attachment
continuation. All five steps remain part of this required end-to-end boundary.

### Source capture and native normalization boundary

The resolver now has an explicit exact-version source manifest and an optional
anonymous byte snapshot. Snapshot copies are verified, sealed and unlinked while
their descriptors remain open. The staging client consumes that descriptor
source rather than reopening an artifact path; the returned native file receipt
must match the frozen content address and size. This does not grant a prompt.

Pinned official Controller source (`dsh-api-session-controller`) resolves each
file receipt with `ctx.fileUploads.resolve(agent, receiptId)` and normalizes
image/file input with `ctx.attachments.admitPromptContent()` before constructing
the native user message. Its model selection checks image modality before
image admission. Preserve that exact official sequence and check the actual
normalized native message, not the original encoded image hash alone.

The required next protocol must bind both the product manifest digest and the
normalized native-content digest under the existing original command. A new
strict source version and admission version are required; existing protocol-3
text remains unchanged. Cold claimed-input recovery, adoption, completion and
historical consumers must validate that same version, original native message
and original Session incarnation before any replay/entry. Do not advertise
attachment support until all those consumers and the UI/native acceptance gate
are connected. A native file-upload test alone is not supplementation acceptance.

## Release

Run focused failures/green regressions, full Gateway/root/UI and changed Adapter/
Host tests plus actual SDK cases. Build locally, review exact changed source,
staged data and history, publish explicit paths to the existing feature branch,
then verify exact remote hash. Record skipped/external-provider gates separately.
No production activation or completion of the 26-capability ledger is implied.

## Current batch evidence

Atomic original HTTP command receipts, locked cancellation checks, current-page
Stop recovery and strict ordinary MessageReceipt handling are implemented. See
[executed evidence and limitations](../../implementation/2026-10-19-run-command-receipts.md).
The mobile API case covers a wrong status-read identity and an ambiguous result
after committed cancellation. The actual SDK mobile case observes native cancel,
original cancelled state and no canonical answer. Final local regression passes
1,832 Gateway tests (seven explicit skips), 237 UI and 67 root tests. Actual SDK
Chat serial tests pass 21 plus the selected original Work case, with no skips.

Ordinary Step 2 text steering is now connected through explicit original-only
API custody and the original owning Dispatcher/native admission. The ordinary UI
uses supplement semantics; Role/Goal authority stays separate. Actual mobile
HTTP lost-receipt and installed-SDK native delivery cases pass. See
[text delivery evidence and limitations](../../implementation/2026-10-19-original-text-steering.md).
Step 3 attachment continuation, durable browser receipt recovery across forced
reload, external-provider and full capability acceptance remain open.

Final text-delivery batch: Gateway 1,841 passed/seven explicit skips; root 67, UI
243, actual installed SDK Chat 22 plus selected Work compaction one passed.
Windows builds/typecheck passed. See the linked implementation record for exact
scope, privacy review and remaining attachment/browser-recovery requirements.

### Attachment continuation under implementation

Internal source protocol 2 and native admission protocol 4 now keep exact product
attachment versions separate from normalized native content. The original SDK
accepts one file supplement on the same running task, confirms a repeated request
without another admission and preserves original browser cancellation. An SDK
injection-boundary regression exposed and fixed direct access to an un-injected
attachment service. The native case uses synthetic local inference; it does not
prove completed file reading or image understanding.

Detached claimed-input recovery now has a separately gated protocol-4 reader;
focused tests preserve immutable source/native identities without upload or
execution during recovery. The cold composer forwards this opt-in and verifies
bytes around original preset setup; live and historical completion observers
match source and normalized immutable admission. An actual installed-SDK case
restores a claimed file supplement across Host termination, then verifies
historical acceptance repair and unique final publication without another model
call. The same case exposed and fixed a text-only recovery preflight; the original
adoption gate still validates immutable admissions and stored bytes. This uses
internal command preparation and scripted inference, not the public composer.
The explicitly configured original Dispatcher now handles source protocol 2 and
confirms existing native admission before source access. Its default remains
disabled. Acceptance lookup uses the original immutable receipt store rather
than absence from a compacted logical surface; missing request indexes fall back
to a read-only primary scan. A native lost-reply/missing-source case verifies one
upload/prompt/run. Public steer accepts owned IDs, creates its own manifest and
commits command/custody/HTTP receipt atomically. Native readiness requires all
matching admission/recovery/history consumers. The actual cold file case now
starts through that API and Dispatcher.

Composer controller/component wiring has been added behind advertised support;
unknown HTTP outcomes retain exact original upload IDs and target/version/key.
The [fixed-version projection and actual mobile file case](../../implementation/2026-10-19-pinned-attachment-sources.md)
now cover live/reloaded historical previews, real React/BFF upload/steer,
original SDK cold recovery and unique final publication. Serialized product
messages and native source hashes are unchanged. Mobile file-only, unknown-reply
and image cases pass in the final five-case combined actual-SDK matrix, including
a correction to the official owning model-selection service. Larger multi-file/
image batches and the broader capability ledger remain open. Full current
Gateway, Adapter, UI and root regressions and the staged privacy comparison are
recorded in the implementation evidence. This increment targets the existing
feature branch; default API/Worker flags and production remain off. The full
26-capability ledger remains the release scope.
