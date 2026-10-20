# Historical sources for reviewed work

`FinalizedWorkSources` reads the exact isolated text versions accepted by the
owner and committed by the original task finalizer. This supplies historical
source evidence for the separate publication review in the
[original implementation plan](../superpowers/plans/2026-10-20-work-review-publication-chain.md).
It does not publish files or enable Git writes.

## Original records, one read snapshot

The reader joins the original owned conversation/project, task occurrence and
successful finalization. It checks the original accepted review and business
certificate, completion candidate, frozen proposal and context, original run
binding, pre-completion checkpoint, native Goal completion proof, completed
checkpoint and final assistant message. The existing completion boundary parser
is exported as a pure validator; historical reads never call the live completion
or waiting-review mutation paths.

The original work admission is resolved through its existing historical lineage
reader. The frozen full inspection is revalidated, including both inventories,
recomputed diff, original call set, saved tool ledger, execution receipts and
byte digests. Each original written version is checked through the existing
isolated output reader. For repeated writes to a path, the highest version in
that frozen inspection is returned; later writes or mutable tree contents do not
select a different version. Corrupt earlier versions also invalidate the read.

`summary(owner, runId)` returns original IDs, the relative inspection inventory,
per-file versions and digests, and a digest over the complete source facts.
`content(owner, runId, path, expectedSourceSha256)` revalidates those facts and
returns exact original UTF-8 bytes. A changed source digest conflicts. Neither
method accepts a host root or reads a current filesystem tree. The response
contains no host directory, native execution context or renewed permission.

Construction performs no schema installation. Independent reads use a deferred
SQLite snapshot that is rolled back after reading. An existing caller transaction
is retained and is never committed or rolled back by this reader. No model call,
event, artifact, lease, retention update or task transition is created. A current
policy pause does not rewrite accepted history; current owner/project checks
still apply, including ownership transfer.

## Boundaries still open

Ordinary/planning completions and mixed generated-output candidates cannot be
silently promoted to isolated publication sources. Unsupported changed paths
remain explicit in `unsupported_changes`; a future publisher must refuse them
until it validates their original producer-specific bytes. Rename, deletion,
mode changes, binary/generated/shared output and unchanged original base content
are not implemented as a complete publication mechanism by this reader.

The source reader creates no HTTP endpoint, target intent, apply approval or
filesystem effect. The subsequent [internal target review](2026-10-20-work-publication-review.md)
binds its digest and selected versions to the actual configured target, with a
separate owner review. `readSelection` supplies the selected exact versions in
one original read snapshot rather than rescanning all receipts per file. That
review still requires original project/native producer custody and interrupted
publication journals before any effects. Historical acceptance alone cannot
authorize those operations.

## Verification

The initial eight dedicated tests passed using the real isolated write, inspection, proposal,
owner review, native completion handshake and original finalization paths. They
cover exact bytes and versions, later mutable changes, no read-side effects,
current policy pause, unfinalized/foreign/missing/transferred sources, invalid
digest/path, original candidate/certificate/inspection/tool-proof corruption,
both versions of a rewritten file, rehashed native proof replacement, physically
read-only SQLite, ordinary discovery rejection and caller transaction ownership.
The subsequent batch-selection case and current integrated regression are
recorded with the [publication review](2026-10-20-work-publication-review.md).

The final complete Gateway run passed **2,098 tests**, with **20 skipped**, zero
failures and zero cancellations (2,118 total). All 591 enumerated Gateway source,
test, contract, script, template and package files were unchanged from the start
of that run through its terminal result. Gateway typecheck/build, root tests
(67), interface tests (253) and the local frontend build passed. The six public
review checker regressions passed; the final source scan found no findings.
An earlier concurrent tree scan could not read a locked temporary test file;
only the stable scan after the full suite ended is treated as final tree evidence.

Restricted-shell loopback/browser tests initially failed because of local OS
network/process restrictions. Authorized user-context reruns passed; those
initial environment failures are not recorded as successful test runs. Existing
platform/provider skips remain separate from executed checks.

Platform/provider integration and the remaining publication/Git/checkpoint/mobile
chain are separate acceptance items; this source reader does not complete the
full PilotDeck or portable Chat/Work scope.
