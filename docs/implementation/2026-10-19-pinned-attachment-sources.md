# Exact attachment sources for original-task continuation

This records the approved original-task attachment continuation implementation,
from immutable source preparation through opt-in API, mobile composer, native
admission, recovery and historical preview acceptance. Earlier sections preserve
the bounded milestones; the final sections record current integrated evidence.
Default configuration still refuses unsupported in-flight attachments rather
than creating a replacement task. Original native text steering remains intact.

## Exact catalog identity

`AttachmentResolver.pinForMessage` creates a protocol-1 source manifest from
owned, ready, conversation-scoped artifacts. It fixes ID, version, digest, size,
media type, display name and classification without serializing a server path.
Pinning and the existing cleanup leases share the original SQLite transaction.
Duplicate IDs or invalid persisted metadata cannot leave partial leases.

The pinned resolver reads the specified version after database reopen or current
version changes. It refuses foreign scopes, metadata substitution, absent or
corrupted bytes, archive/restore requirements and invalid paths or junctions.
Streaming hash/descriptor verification runs outside a SQLite transaction. A
short final transaction rechecks the original catalog and atomically renews all
existing cleanup leases; a late SQL failure leaves no partial retry lease.

## Byte capture rather than later path reopening

Returning a verified local path does not freeze future bytes. The explicit
snapshot path captures each verified version into an operator-private file,
seals its digest and length, and unlinks it while retaining its descriptor.
The returned sources expose only digest, size and bounded asynchronous reads.
They expose no reusable filesystem path. Disposing a batch closes descriptors;
failure and cancellation clean prepared copies before exposing a batch.

Each source supports sequential reads, rejects concurrent reads, checks abort
and closure around awaits and verifies its streamed digest. Copying and staging
remain separate from model execution. The staging consumer must still validate
the original task's current ownership, lease and native admission. Snapshot
availability or a cleanup lease cannot revive revoked task authority.

`SessionControllerClient.stageVerifiedFile` uploads the anonymous byte stream
through the existing authenticated original Session file endpoint. It checks
returned receipt shape, content address and byte length before confirming the
staged file. It does not send a native prompt, mark a command applied or claim
file reading/image recognition. There is no automatic upload retry.

## Executed focused evidence and remaining native gate

Source tests cover old-version reuse/reopen; invalid/foreign manifests;
corruption, missing files, path escape/junction and cancellation; all-or-nothing
leases; zero-byte files and bounds; anonymous copy reuse after source replacement;
disposal/concurrent-reader guards and rejected upload receipt identity. The real
loopback HTTP test verifies the uploaded bytes rather than only a mocked call.

The actual installed SDK test creates an original synthetic Chat task, then
stages the exact anonymous bytes into that task's saved native Session after
replacing the source file. Official storage returns the original content-addressed
file reference. This adds no native prompt, model request or product run. The
initial synthetic Chat question is only the existing fixture setup. It is not
end-to-end attachment supplementation or external-provider vision evidence.

## Versioned original-task admission progress

The internal command payload now carries the exact source manifest. Source proof
protocol 2 binds that manifest and the original text independently of normalized
native bytes. The explicitly enabled Host uses official file receipts and image
normalization, verifies stored bytes and writes immutable admission protocol 4.
Legacy text proofs remain unchanged. The SDK's injection-restricted context must
resolve the attachment service through its service accessor; a regression covers
this boundary rather than assuming a plain JavaScript context.

An actual installed SDK test now accepts one file supplement on its original
running task after the original disk source is replaced. Repeating the request
produces one private admission, one product run and no second native insertion.
The browser's explicit Stop still reaches the original Dispatcher and cancels
that task. This uses a local scripted provider and proves admission before
cancellation, not completed file reading, image understanding or provider quality.

The detached claimed-input setup has a separate explicit attachment opt-in. It
matches the original immutable protocol-4 receipt, complete native-message hash,
manifest digest, owner, parent, Session incarnation, profile and current lease.
It never uploads, normalizes or creates a receipt during restoration. Focused
tests cover restoration, disabled/legacy consumers, source/content substitution,
missing capability, invalid digest and reserved entry. This is helper-level
evidence. The unpublished-factory composer also forwards the explicit opt-in,
checks claims before and after original preset setup and verifies actual stored
file bytes before publishing the restored Agent. Its tests reject substituted
bytes, source changes during setup and disabled/missing capabilities.

The live completion reader accepts the same explicitly enabled source/admission
versions and compares both the manifest digest and actual normalized content
against the immutable receipt, with unchanged final-turn/answer checks. It is
read-only and does not claim file understanding.

Historical source protocol 2 carries the pinned manifest rather than claiming
knowledge of normalized bytes. Historical observers require the complete bound
source digest, explicit attachment opt-in and original protocol-4 native stamp.
Acceptance repair and final publication preserve attachment references, including
an attachment-only input; they retain original atomic receipts and never replay
the native task. Legacy text source/receipt formats remain unchanged.

An actual SDK case now admits a file supplement, terminates the Host after the
message is claimed but before entry, restores the original Session under the new
lease and verifies the unchanged native file identity. A further Host restart
then allows historical acceptance repair and unique final-answer publication.
Repeating those repairs does not add model calls or change private admissions.
The original product run is retained. This uses local scripted inference and
internal command preparation; public composer/Dispatcher delivery and file
understanding remain separate gates.

The case exposed a remaining text-only recovery preflight. Its explicitly enabled
attachment branch now validates normalized metadata; immutable admission and
stored-byte checks still happen in the original adoption layer before entry.
Focused recovery/history tests pass 63 cases. Latest full Adapter regression
passes 728 with 25 explicit skips. Latest affected Gateway history/publication
suite passes 49 with one opt-in load-measurement skip, and Windows build passes.
The earlier full Gateway run passed 1,875 with seven skips before these final
history edits; it must be repeated before publication. Earlier actual SDK Chat
serial 24, root 67 and UI 243 results remain separate baseline evidence.

## Original Dispatcher and public acceptance

An explicitly configured original Dispatcher now observes native acceptance
before opening source files. A confirmed admission skips upload and prompt;
otherwise it snapshots the exact owned versions, streams native files or sends
bounded encoded images and rechecks the original Worker lease/source after every
await. Anonymous copies are disposed on success, cancellation and error. Product
message/custody/command acknowledgement remains in the original transaction.
Text-only and disabled consumers keep their existing behavior.

The private native admission store has an immutable request-to-primary metadata
index for protocol-4 records. It is written before the primary receipt; an index
without its matching primary refuses. Lookup verifies both records and original
scope. Missing indexes use a streaming, read-only scan of primary metadata, so a
legacy/partial copy cannot turn a known receipt into a resend. This can cost more
than indexed lookup and does not inspect message or file bodies. The logical
Session surface is not authoritative evidence of non-admission after compaction.

The existing original-only steer API accepts optional owned attachment IDs and
empty text for attachment-only input. It creates the source manifest itself and
commits source leases, command, custody and HTTP receipt atomically. Client
manifests are rejected. Exact completed HTTP retries return the original receipt
after source-version changes or feature rollback. A read-only native readiness
check requires admission, cold recovery, live completion and both history readers
before the API advertises configured attachment support. Readiness is not Worker
liveness or execution authority.

Actual installed SDK cases verify lost native acceptance followed by original
source removal: retry confirms the admission with one upload, one prompt, one
private primary receipt and the same original task. Browser Stop still cancels
that task. Another case now starts through the public attachment API and original
Dispatcher, terminates the Host at the claimed-input boundary, restores the same
Session and publishes one historical answer without another model request.
These cases use local scripted inference. The composer controller freezes upload
IDs with the original target/version/key across ambiguous HTTP retries; its
component forwards attachment support only when explicitly advertised.

Current Dispatcher/API batch: 72 affected Gateway/contract tests passed; complete
Adapter regression passed 742 with 25 explicit SDK-gated skips; complete UI
regression passed 245 without skips. Root 67 tests, Gateway typecheck and Windows
Gateway/Vite builds passed. Actual SDK lost-reply/cancel and API/Dispatcher/cold
recovery/final-publication cases each passed after request-index integration.
Public-source review passed six scanner regressions and 1,061 scanned files;
runtime/build/dependencies are excluded. Full current Gateway/SDK matrices and
history/staged privacy review are still required before publication.

### Configuration and remaining gates

`GENERAL_AGENT_ORDINARY_STEERING_ATTACHMENTS_ENABLED` defaults off in the API and
owning Worker. The Worker requires original input recovery, original steering,
steering reconciliation and final reconciliation, plus native attachment
readiness. The native trusted composition must use the current admission store,
`ordinaryInputAdmission.attachmentSteeringProtocol: 1`, the original claimed-input
kit, and both history kits. An old/incomplete Host fails readiness; a route flag
alone cannot make it ready. This work does not enable any production switch.

The fixed-version projection and mobile cases below supersede the earlier
preview/mobile gaps. Still required: larger multi-file/image batch acceptance,
publication review and the broader original capability ledger. File handles and scripted
responses do not establish real-provider file reading or image understanding.

### Fixed-version historical previews and actual mobile file delivery

Messages keep their original serialized `content_json`; input hashes and native
admission identities are unchanged. A read-only message projection derives
`attachment_refs` from the exact applied original command, run, conversation,
client message ID and serialized content. It validates the retained source
manifest and exposes only version, digest, size, media type and filename. It
does not read disk or select `current_version`, create another authoritative
store, or grant execution. Snapshots, message lists and individual message reads
use this same projection. Live acknowledgement, acceptance repair and historical
final publication expose the same metadata from their already verified source.

The UI uses those immutable values for versioned preview/download requests,
including when the current artifact falls out of the paged inventory. It does
not borrow newer filename/media/hash/size or archive state. Explicit unavailable
provenance suppresses current-version substitution and displays a notice. Legacy
initial inputs and generated outputs retain their existing separate behavior;
this does not retroactively invent pins for unversioned legacy input. Native
resumption continues using its original normalized attachment references and
immutable admissions, not public preview metadata.

Three UI regressions first reproduced newer-version substitution, missing
inventory and unsafe fallback. Ten source-projection tests cover missing or
pending commands, mismatched run/conversation/client/content, invalid manifests,
file-only input and unchanged serialized content. A real original Dispatcher
case checks agreement across event, repository, snapshot and REST projections
after a later artifact edit. Acceptance-repair and historical-publication tests
also assert the pinned metadata in their public events. REST, SSE and YAML
contracts share the bounded metadata schema and reject server paths/receipts.

Installed-SDK cases cover the existing API/Dispatcher cold file case and mobile
React file, file-only, unknown-reply and image cases. The mobile file case uploads a synthetic text file
through the actual BFF/upload API, sends it through the original running-task
composer and Dispatcher, previews its text, creates a later artifact version,
reloads and still previews the original text/name. It then terminates the Host
at the original claimed-input boundary, restores the same Session under the
replacement lease and publishes one canonical historical answer. It retains one
original run, the original normalized file identity and immutable admissions.
The file-only case preserves an empty product block list and one native file
part. The unknown-reply case drops the browser response after the real upstream
202, retries the same body and mutation key, and verifies the same receipt and
one original command/run. Both retain the original cold-recovery and historical
final-publication checks.

The image case exposed an actual SDK integration error: `ctx.agents` is the
Agent registry, while the owning Session model selection is provided by
`ctx.sessionController.agents.selectionFor(agent)`. The image preparation helper
now uses that official service; a regression reproduces the registry/controller
distinction. Image preparation still enforces source bytes, model modality,
normalization, original ownership and cancellation. The actual mobile case
verifies a decoded synthetic image before and after a new artifact version and
reload, then verifies the normalized native content digest against the original
immutable admission after cold recovery. Raw image hashes are not substituted
for normalized native hashes. A separate real Gateway/BFF test verifies the
original PNG bytes. The renderer checks decoded dimensions/pixels; it does not
weaken CSP to fetch Blob URLs for test instrumentation.

Inference is local and scripted; this is browser delivery/recovery evidence,
not file-understanding quality or live-provider billing evidence.

The UI suite passes 248 tests; the corrected Adapter passes 743 with 25 explicit
SDK-gated skips. Full Gateway passes 1,915 with seven explicit skips, and root
tests pass 67 including actual PNG download. Native Chat's complete 25-case
installed-SDK suite passes without skips; the later image-specific correction
has its own actual mobile SDK case and complete Adapter regression. Windows
Gateway/frontend builds pass. Public preflight passes six scanner regressions
and 1,063 source files. The historical scan reports the same seven previously
reviewed findings across 183 commits/2,717 blobs; it is not a zero-finding history
claim. The final combined five-case API/mobile/native matrix passes without
skips after the image-service correction, including exact original mutation-key
retention on a lost browser response. The staged Git comparison reports exactly
the same seven known historical findings, with no additional findings from this
increment. This increment targets the existing feature branch; production flags
remain off. The broader capability ledger and larger batch acceptance remain
open and are not replaced by these attachment results.
