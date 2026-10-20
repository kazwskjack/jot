# PilotDeck code reuse and strengthening review

## Scope and evidence

The approved direction is to retain Jot and its DSH controller while porting
PilotDeck module by module, including code, complete functionality and the
reason for each design. Reusable Jot code must receive the same comparison.
An existing implementation is not automatically sufficient, and a difference
from upstream is not automatically a reason to rewrite it.

This first source review covers the active file-review, checkpoint and Git
chain. It does not certify the other capabilities in the 26-capability ledger.
The inspected local PilotDeck commit is
`783499ffdb2d501bf590b2e035acd027a882df10`; this is a pinned reference,
not a claim about the current upstream release. Paths below are repository
relative so this document remains portable.

Upstream source is AGPL-3.0. Jot's Apache-2.0 declaration does not relicense
copied source. Before distributing a copied module, retain its actual license,
authorship and provenance and resolve the combined distribution obligations.
No upstream source was copied by this review.

## Decision rules for every capability

Record the upstream files and symbols, dependency boundary, existing Jot
counterpart, user-visible behavior, design reason, reuse decision and acceptance
evidence. Distinguish reasons stated in source comments from reviewer inference.

Choose one of: reuse unchanged; reuse with an adapter; strengthen an existing
implementation; retain Jot's implementation because it already meets the
requirement; or explicitly unsupported pending a concrete integration. State
which actual code is retained or ported. Do not call an interface imitation a
source port, or mark a whole capability complete because a helper passed tests.

Strengthening requires an observed functional gap, deployment difference or
reproducible failure. Each change must name a testable outcome. Do not add a
second planner, scheduler, workspace lock or permission system to duplicate an
existing authority.

## Source comparison: current integration chain

| Module and upstream source | Existing behavior and why | Jot comparison | Decision and required acceptance |
| --- | --- | --- | --- |
| `src/tool/builtin/filesystem/structuredPatch.ts`: `buildStructuredPatch`, `buildUnifiedDiff` | Pure functions find common prefix/suffix and produce one changed hunk with three context lines. No imported runtime dependencies. Reviewer inference: a small preview implementation avoids a separate diff dependency. It is not a minimal multi-hunk diff algorithm. | `packages/gateway/src/persistent-tasks/work-publication-intents.ts` already retains reviewed before/after text and immutable byte versions, but that is not a compact line-diff renderer. | Candidate for attributed source reuse behind a preview adapter. Keep byte hashes as execution authority; preview text never becomes replacement bytes. Verify empty/add/unchanged/CRLF/final-newline/Unicode and distant edits. Add multi-hunk output only if real preview usability or size evidence requires it. |
| `src/session/checkpoints/WorkspaceCheckpoints.ts`: object storage, manifests and `restore` | SHA-addressed objects; preview binds expected and target versions; restore checks current state before and during application. A `before_restore` checkpoint and `pendingPath`/`applied` journal preserve recovery evidence. This behavior is explicit in source. | Jot separates logical immutable task outputs, historical native source and the configured physical checkout. `finalized-work-sources.ts`, `work-publication-intents.ts`, `git/publication-effects.ts` and the new original foreground producer/journal now connect the local supported-text path. Full product publication remains unfinished. | Compare checkpoint algorithms and recovery semantics for adaptation, keeping the original Jot identities and immutable bytes. Strengthen provenance across isolated-source/target roots and owner-approved versions. Acceptance: actual apply, interruption before and after replacement, restart inspection, conflicts, explicit recovery and no overwrite of unrelated edits. An internal prepared record is insufficient. |
| Same checkpoint file: `leases`, `acquire`, `busy` | An in-process overlapping-directory queue serializes turns/restores; background command holds extend busy state. Source explicitly describes the lease as spanning a turn or restore rather than a session. | Jot has multiple processes and original project/native reservations in `packages/gateway/src/workbench/workspace-coordination.ts`. A module-local queue cannot coordinate those processes by itself. | Retain Jot coordination and adapt upstream callers to it; do not introduce a second authoritative queue. Verify two processes and overlapping roots, native session draining, cancellation, Worker loss and unresolved effects. Do not equate an expired lease with completed file effects. |
| Same checkpoint file: `applyFile` | Restores original object bytes via an exclusive sibling temporary file and rename; rejects a symlink/non-file target. Deletes absent versions. Reviewer inference: same-directory rename avoids a partially copied final file. | The draft Jot publisher distinguishes new-file insertion from existing-file replacement and pins original target facts. It currently supports selected text additions/modifications, not the complete upstream restore surface. | Compare and reuse the proven low-level patterns; strengthen only where source/target review or cross-process requirements differ. Verify newly created parent directories, existing target races, cancellation, ambiguous acknowledgements and original bytes. Keep delete/binary/mode/rename behavior explicitly open until implemented and reviewed. |
| Same checkpoint file: capture limits and `prune` | Source constants cap checkpoint files at 10 MiB and workspace capture at 256 MiB; pruning defaults to 100 rounds and completed restores. Unsupported versions are represented as unprotected rather than silently restorable. | Jot retains immutable evidence and task versions with different lifetimes. A checkpoint retention limit is not a Goal token/round limit and must not impose one. | Reuse bounded capture and visible unsupported-state concepts. Adapt retention to references from active reviews, publication and recovery. Test that live/recovery references survive garbage collection; measure bytes written and retained. Do not copy retention constants as unexplained product limits. |
| `src/session/checkpoints/repositoryOperation.ts`: `runRepositoryOperation` | Uses `execFile` argument arrays, literal selected pathspecs, expected index-tree verification before commit, branch validation and non-force push. These checks are directly visible in source. | Jot already has configured repository inspection, original owner/version reviews and index execution services in `packages/gateway/src/git/`. Upstream also exposes init, checkout, commit, fetch, push and remote configuration, which are not equivalent to local index staging. | Reuse operation algorithms through typed adapters to existing reviews and producers. Do not expose the helper as an unrestricted command endpoint. Validate hook/filter/config execution behavior, cancellation, credentials, output redaction and remote-changing effects per operation. Acceptance includes actual selected-path staging, changed-index refusal, reviewed commit and non-force push to a disposable local remote. |
| `src/session/worktree/resolveCanonicalRoot.ts`: `resolveCanonicalRoot` | Validates worktree layout and backlink, normalizes real paths, caches up to 50 entries, and deliberately falls back to the supplied root on failures. Its comments explain identity normalization and graceful fallback. | Jot physical execution needs a fresh configured target witness. A cached logical repository identity is not proof that the same physical directory still exists or is authorized for writes. | Reuse identity normalization for discovery where appropriate. Retain fresh Jot physical identity checks for effects; discovery fallback cannot grant execution. Verify legitimate linked worktrees, forged backlinks, root replacement, stale cache and path spelling differences on supported platforms. |

## Concrete known gap, not speculative strengthening

The initial physical-publication kernel test run had five passing cases and
one failing nested-file-add case. The failure occurred before the kernel:
`WorkPublicationIntents.selected` rejects `unsupported_changes`, which currently
includes structural added directories. The kernel's ability to create parents
therefore does not complete the user workflow.

The fix retains the original inventory and permits structural ancestors only
when proven by the original selected file additions and reviewed target state.
Other unsupported changes still refuse. The nested-file test was retained;
additional tests cover the review, directory selection refusal and a parent
replaced by an unrelated file. All three nested cases passed in the Windows user
context. The sandbox denied the hard-link primitive; no overwrite-capable
fallback was substituted. See the
[current source-custody and effects evidence](2026-10-20-publication-native-source-and-effects.md).

The source-custody/local-kernel increment did not certify end-to-end publication.
The subsequent [foreground producer and recovery](2026-10-20-publication-producer-recovery.md)
connect original Worker authority, durable effects, native-prefix readback and
explicit owner resolution for supported text files. Its final gates, multiple
historical roots, transport and product entry remain separate requirements.
Earlier admission or source-custody tests are not substituted for that evidence.

## Reusable Jot code: retain or strengthen

The comparison applies to existing code as well as upstream candidates. These
decisions concern the current publication chain, not certification of all 26
capabilities. Verification references below are local tests; final suite and
product-entry acceptance are recorded separately in the producer report.

| Reusable implementation | Sufficiency comparison | Decision and reason | Evidence or remaining acceptance |
| --- | --- | --- | --- |
| `git/index-effects.ts`: `sourceMetadata()` | Existing metadata witness already separates repository configuration/index/refs from content-addressed object growth. Rechecking every object as mutable metadata would reject unrelated object creation. | Reuse through the subclass, changing visibility to protected; retain a separate objects-directory identity check. No second object-store scanner. | Kernel tests allow unrelated object growth and refuse configuration drift; root/directory replacement checks remain. |
| `session-adapter/checkpoint.js`: existing checkpoint receipt/header and canonical prefix hashing | The proof format is reusable. An ordinary verifier that waits for Agent idle cannot be invoked inside maintenance that itself keeps the Agent active. | Reuse canonicalization and original read-only persistence. Add `verifyHeldSessionCheckpoint` for the retained-maintenance context, preserving exact headers, event continuity and prefix hashes. | Held-checkpoint tests plus actual SDK history-prefix cases, including an inconsistent real prefix with self-consistent database metadata; later suffix history is allowed. |
| `session-adapter/native-workspace-barrier.js` and `native-workspace-source.js` | Existing native custody and original Session admission remain authoritative. A serialized source receipt alone is insufficient for later file effects. | Retain original custody; strengthen the private ephemeral context with cloned original headers and before/after source verification. Do not expose headers as new public write authority. | Existing source/barrier tests and SDK producer cases; multiple historical isolated roots and transport remain open. |
| `workbench/execution-lease.ts` and original `ga_worker_leases` | Existing owner/generation fencing is sufficient; a new publication-specific lease store would duplicate authority. | Reuse the original Git-binding resource namespace and lease assertion. Add publication heartbeat and exact-generation cleanup only. | Replacement-Worker test refuses stale effects and preserves the replacement lease. Cross-process crash cases exercise the original database. |
| `workbench/workspace-coordination.ts`: original reservation and settlement | Original reservation is reusable. Existing index-only settlement evidence cannot prove completion of file publication. | Keep the same reservation tables and native drain; dispatch publication settlement to validated original journal evidence. | No-producer settlement must still refuse. Missing receipt is unknown, not permission to release or replay. |
| `persistent-tasks/finalized-work-sources.ts`: original immutable material | Original bytes, source hash and completed task identity are reusable; completion acceptance does not grant target-write permission. | Retain material retrieval; add the original completed checkpoint to the private source placement and require a separate owner-approved publication review. | Actual original-source producer cases; wrong native prefix refuses before any file effect or Worker claim. Broader binary/delete/rename coverage remains open. |
| `git/publication-effects.ts`: selected-text kernel | Existing target witnesses and one-use prepared plans are reusable. Real Windows output exposed an actual mode mismatch; nested directory evidence also exposed an integration gap. | Strengthen platform mode verification and original structural-ancestor evidence. Retain no-overwrite insertion and exact bytes, without copying the upstream restore surface wholesale. | Windows focused tests for modes, nested additions and target races. New platform/provider/product acceptance is not inferred from these results. |

For every future reusable module, record **why no strengthening is needed**
when retaining it unchanged. If strengthening is required, name the observed
gap, smallest affected code boundary, compatibility impact and executable
acceptance. A source difference alone is not a defect. Prioritize closing the
working user path over duplicating mature infrastructure.

## Apply this comparison to the remaining ledger

The [scheduling source review](2026-10-20-pilotdeck-scheduling-source-review.md)
applies the same source/function/design-reason and reuse comparison to capability
09. It identifies general cron/delay inputs as gaps while retaining original
task storage, calendar rules, occurrence admission and Worker authority. This is
source-review evidence, not scheduling parity or a completed implementation.

For each of the 26 existing rows, attach a module record with:

1. Pinned upstream files/symbols, dependencies and relevant existing tests.
2. Complete user-visible functionality, including failure and recovery behavior.
3. Why the implementation exists, with stated versus inferred reasons marked.
4. The matching Jot files and an observed gap or an explicit sufficient result.
5. Exact reuse/adapter/strengthening decision and retained upstream provenance.
6. A working product path and executable acceptance for success, cancellation,
   ownership, interruption and supported platforms as relevant to that module.
7. Separate local implementation, local acceptance, external-provider acceptance
   and deployment status. No overall completion percentage from helper counts.

Close each coherent product chain before expanding prerequisite machinery. This
review adds a comparison requirement; it does not reset completed functionality
or authorize replacing DSH with the upstream runtime.
