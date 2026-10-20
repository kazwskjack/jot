# Publication admission in the original workspace coordinator

The publication review now has an immutable original admission and a distinct
`work_publication` kind in the same project reservation system. This is not a new
task manager, native runtime, mutex namespace or file executor. Original DSH
planning, ownership, immutable evidence and Worker authority remain unchanged.

## Controlled original schema upgrade

The default existing bootstrap retains its legacy `git_index` table constraint.
`upgradeWorkspacePublicationCoordination` is an explicit, synchronous **offline
maintenance** operation, not an automatic constructor or server migration. It
recognizes only the original known table definitions. Formatting normalization
preserves case and whitespace inside SQL literals; unknown constraints and
replacement tables are refused rather than repaired or deleted.

The upgrader follows SQLite's [generalized table-change procedure](https://www.sqlite.org/lang_altertable.html#otheralter).
On its isolated maintenance connection it changes foreign-key policy before
the transaction, creates the revised table, copies original rows, replaces the
table and restores original indexes, views and triggers. It preserves dependent
triggers attached to other tables too. Foreign-key policy is restored on both
success and failure; no `writable_schema` manipulation is used.

It streams inventories of the original reservation and transitive foreign-key
dependencies, then compares row counts/hashes, the complete retained schema and
foreign-key checks before commit. Only the expected parent-row copy may change
rows. Synchronous progress/test observers cannot bypass the final checks, and
async-function observers are refused before invocation. Connections with
temporary fences are refused. Failures roll back the complete original schema.

Recorded Workers, active/queued runs, unresolved workspace reservations, pending
isolated writes, unsettled model usage and unresolved native/Git producer facts
block maintenance. An expired lease is not proof that its process stopped.
Existing immutable reservations, releases, family seals and settlements retain
their original bytes and hashes. A repeated upgrade or a read-only observation
of the current schema performs no schema/data change.

These database checks **cannot prove that idle external pools or native
processes have stopped**. The result deliberately carries
`offline_pool_drain_observed: false` and `execution_authorized: false`. An operator
must drain the original services before maintenance; this function neither
stops them nor supplies a force override. No production migration or deployed
pool-drain acceptance is claimed by the local tests.

## Original immutable admission

`WorkPublicationExecutions.admit` runs only within the original synchronous
database transaction. It consumes the exact current approved review version and
digest through `WorkPublicationIntents.executionSource`. That read revalidates
the original finalized source and configured target scope in the same physical
database. Caller-selected roots, executors, bytes and alternate databases are
not accepted. The saved admission pins review, source, target, configuration and
original database identity, with one immutable request and acceptance receipt.

Admission creates no file, index effect, task, native Goal, model attempt or
Worker lease. Retried requests return the original acceptance; changed requests
conflict. `getAdmission` is historical and works on a physically read-only
connection without migrations. Copying an old acceptance to another database
does not supply current authority. A historical acceptance can still be read
after review cancellation, but it cannot reserve or execute work again.

## Same original project and native-family fences

The owning service derives a `work_publication` source from that admitted record
and reserves/seals the existing project family. It cannot take a caller's Session
list or substitute Git index identity. The original shared-file guard and
Worker claim path see the same reservation and remain blocked. Current source,
owner and review are checked before fresh custody; revocation never silently
releases an existing hold or turns a historical response into a dispatch grant.

Pre-dispatch release is explicit and available only to the original owning
admission-only service. An unrecognized publication lifecycle table prevents
this version from claiming no producer exists. Publication settlement explicitly
refuses index-only evidence. This is deliberate unfinished lifecycle integration,
not permission to clear a hold by lease timeout, matching bytes or a guessed
rollback. This implementation has no physical dispatch method or HTTP/tool/UI
activation path.

## Local verification

Tests use original work inspection/review/finalization and real local Git targets.
They cover source-preserving migration, released reservation/family retention,
copied/recreated/final verification faults, actual maintenance process exit,
dependent views, real orphaned dependency refusal, restored immutable triggers,
read-only/idempotent observation, temporary fences, literal-sensitive schema
recognition and an actual original pending Git admission blocking upgrade.

The admission suites verify exact request replay, current review and ownership,
transaction rollback including family custody, unknown producer storage,
read-only recovery and copied-database refusal. The original Worker actually
skips a held project and can claim the same queued input after explicit release.
Real shared-file writes are refused before blob creation; accepted metadata
does not modify target files, index, model usage or Worker counts. The fixture
keeps the original logical workbench distinct from the configured Git workbench.

The focused admission, schema-upgrade, original reservation and original review
run passed all 54 cases, with zero failures, cancellations or skips. Gateway
typecheck and local build passed. The standalone root passed 67 tests, the
workbench/Jot interface passed 253 tests, and the frontend build passed. The
public-tree/history verifier's own regression tests passed all six cases.

The full Gateway regression completed with 2,163 tests: 2,143 passed, 20
conditional skips, zero failures and zero cancellations. All 600 enumerated
Gateway source, test, contract, script, template and package files matched the
pre-run hashes after the actual test process exited successfully. Conditional
skips do not establish external-provider, SDK or deployment acceptance.

Stable source/staged/history disclosure gates remain required before publication.
Native publication, external-provider and production acceptance remain separate.

## Remaining actual publication chain

The [original plan](../superpowers/plans/2026-10-20-work-review-publication-chain.md)
still requires the authenticated original native host to carry this distinct
operation through complete family maintenance and the exact Worker lease. It
must associate maintained original source contexts with the explicitly reviewed
physical target, not equate an isolated copy with a Git checkout by directory.

Next add actual producer start/preparation/per-file dispatch and outcome journals,
original source/target guards at physical effects, awaited native/kernel cleanup
and producer-specific settlement. Process loss and ambiguous acknowledgements
must retain original custody without replaying unknown writes. Directory,
binary/shared/generated, rename/delete/mode and checkpoint interactions retain
their own unfinished provenance and recovery requirements. Only after those
paths pass should original HTTP/mobile apply/current/disposition and Git write
activation be enabled. The full 26-capability and portable Chat/Work goal remains
open.
