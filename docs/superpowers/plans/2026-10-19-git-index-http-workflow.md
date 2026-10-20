# Original Git execution HTTP and workbench workflow

Continue [Git workbench task 4](2026-10-19-git-workbench.md) and the
[durable execution plan](2026-10-19-git-durable-index-execution.md). DSH remains
the planner. Reuse original ownership, review, operation records, Worker leases,
HTTP atomic acknowledgements and request recovery. Do not create another task
planner or adopt unrelated internal/native requests as UI work.

## 1. Durable original acceptance

- [x] Separate synchronous original admission from asynchronous index effects.
  Commit the original execution and immutable accepted receipt in the caller's
  existing HTTP transaction. Rollback must leave no accepted execution or lease.
- [x] Preserve the exact accepted response after current state changes, approval
  cancellation, acknowledgement loss and database reopening. Read the current
  execution separately. Never turn a cached acceptance into fresh authority.
- [x] Execute only the stored original request and review; do not accept another
  root, action, selected path, binding or lease in the dispatch body. Prevent
  automatic adoption of native/internal executions lacking original UI admission.
- [x] Keep the existing trusted direct execution contract and its crash/lease
  acceptance intact while sharing original registration logic.

## 2. Original HTTP, shared contracts and lifecycle

- [x] Add separate original-acceptance and current-result history reads with
  current owner checks, strict shared schemas, original BFF and no-store/cancellable
  workbench client calls. Do not adopt internal executions or dispatch on reads.
- [ ] Join original owner/CSRF/idempotency prehandlers, atomic receipt protocol,
  schemas, operation manifest, generated/event definitions and BFF whitelist.
  Cached responses must still check current ownership and service readiness.
- [ ] Use committed original acceptance before any physical dispatch. Separate
  original acceptance from current outcome; preserve request IDs and bodies on
  uncertainty. Never run asynchronous effects inside the root SQL transaction.
- [ ] Restore only original accepted operations, not arbitrary internal pending
  rows. Known preparation failure, interrupted/unknown effects, active producers
  and lost acknowledgements need distinct durable producer facts. Unknown effects
  must not be retried, and known failures must not loop indefinitely.
- [ ] Bind cancellation/drain to the original server/Worker lifecycle and exact
  operation. Native agent calls additionally require their original Session/run/
  role permission and cancellation guards; a UI approval is not a grant to a
  different agent context.

## 3. Original workspace coordination before write activation

The [original producer lifecycle increment](../../implementation/2026-10-20-git-producer-lifecycle.md)
now journals original executor start/finish facts and prevents automatic retries
of an interrupted or known failed pending preparation. This is a prerequisite
within section 2, not completion of its HTTP/Worker lifecycle or any coordination
checkbox below. Original admission, effect and producer observations remain
separate; existing pre-upgrade pending producers require explicit reconciliation.

The [native family maintenance primitive](../../implementation/2026-10-20-native-workspace-barrier.md)
now holds every supplied original resident Session through one awaited callback
and has installed-driver evidence for queued input. It requires the owning
reservation and authoritative family membership; neither is manufactured by the
primitive. Actual Gateway/shared/checkpoint coordination remains open below.

The [original project reservation groundwork](../../implementation/2026-10-20-project-workspace-reservations.md)
now fences actual Worker claims, direct run activation and shared-file allocation
in their product-database boundary. It verifies original Git admission and only
supports unstarted release; joining complete native membership, physical root
publication, settled producer drain and checkpoint restore remains required.

The [member and cold-storage integration increment](../../implementation/2026-10-20-workspace-family-cold-storage.md)
now derives original historical Work/Chat/child membership, fences identity
changes and retains cold storage ownership alongside resident maintenance.
Absent IDs require the existing reviewed Jot protocol-2 factory hooks and an
authentic private hold; they are not reported as owned empty logs. Actual SDK
tests cover original create/resume exclusion and a pending factory writer.
This does not complete the original authenticated host bridge, root/publication
association, producer drain or mobile mutation workflow; keep the checks below open.

The original adapter can now read the reserved family through the existing
authenticated loopback service channel. Gateway rechecks original admission,
approval, ownership and binding; the adapter verifies and freezes the response
without admitting a new member or caching prior authority. Real HTTP and restart
checks preserve the original index and producer state. This read channel does
not itself establish held native custody, original physical dispatch or an
asynchronous replacement for the original dispatch guard.

The adapter's original `createNativeWorkspaceSourceHost` now composes that
authenticated source with actual resident/cold/absent custody. It resolves no
caller-selected member and retains native handles across fresh source reads.
Actual Gateway/HTTP/installed-native acceptance also verifies original approval
revocation and untouched index/producer/lease state. The original synchronous
reservation check is still mandatory. The composition is not an activated
cross-process Git executor and does not close the coordination checks below.

- [ ] Follow the reference Gateway/checkpoint coordination: Git mutation cannot
  race an Agent turn, shared-workspace writer or checkpoint restore. Reuse the
  owning workspace coordinator, not a second planner or a Git-only busy flag.
- [ ] Verify actual configured Git/project roots and the native/shared workspace
  relationship. Do not silently substitute an unrelated logical or temporary
  repository. Unsupported coordination remains unavailable, not fake-ready.
- [ ] Preserve original repository/lease/source checks through physical dispatch,
  publication and cleanup. Mixed old producers must drain before activation.

Integration points to inspect and wire, rather than a standalone Git scheduler:

- The reference `createLocalGateway.manageCheckpoints` resolves the project,
  checks both checkpoint-store activity and `router.hasActiveTurn`, then acquires
  the repository checkpoint store around `runRepositoryOperation`. Its workspace
  gate is wider than the current Git-index resource lease.
- `packages/gateway/src/harness/worker.ts` binds the original run lease, Session and
  `trustedWorkWorkspace` before entering the existing runtime. Keep that custody;
  do not let a Git approval supply a different `cwd` or task/role identity.
- `packages/gateway/src/always-on/work-run-workspace.ts` and
  `packages/gateway/src/always-on/logical-work-cycle-workspace.ts` resolve/materialize original
  isolated work, while the existing workspace journal pins its source. Check
  source publication and recovery as well as active native turns.
- `packages/session-adapter/index.js` validates `session.header.cwd` and the private
  native work binding. Its current exported API does not expose the reference's
  `manageCheckpoints` coordination. Extend the original owning path rather than
  pretending a Git-only lease is that reference method.
- Operator-configured repository roots and isolated native working roots are
  distinct existing concepts. Establish their actual original binding and
  publication boundary; do not equate them by string, replace either with a
  temporary repository, or exclude native/shared workspace integration from the
  intended final capability merely to pass an HTTP test.

The [maintained source-context increment](../../implementation/2026-10-20-native-workspace-source-context.md)
now exposes actual resident/cold header cwd and digest inside original live
custody, with no invented cwd for absent storage. Original context inspection
rejects copies and expired callbacks; resident header changes invalidate the
maintenance check. Actual Gateway/native acceptance retains and reports its
different native and Git directories. This does not close root association.

Continue the original integration in this order:

1. Resolve each maintained native directory through its original Work binding,
   source journal and operator-configured Git project. Validate physical roots,
   not just path strings, project membership or matching bytes.
2. Bind any shared/isolated publication to its original reviewed source and
   result versions. A selected-index approval must not implicitly copy files
   into another tree or replace a logical source with a temporary repository.
3. Retain the original live native handles, project reservation and exact Worker
   producer custody throughout original index callbacks and checkpoint restore.
   Recheck synchronous authority and source identities at physical effects.
4. Settle the original producer before releasing workspace custody. Preserve
   cancelled/failed/unknown outcomes and exact receipts without replay.
5. Only then expose original HTTP execution and mobile stage/unstage controls,
   including lost acknowledgements, restart, cancellation and conflicts.

The [reserved original native executor](../../implementation/2026-10-20-reserved-native-index-execution.md)
now composes actual same-Host startup admission, live native maintenance,
configured-root identity and the original executor through physical stage/unstage.
Success settles original producer evidence and reservation release atomically;
lost callback/settlement acknowledgements retain the reservation without replay.
The uncoordinated path still cannot bypass its own held reservation. This is the
real local composition, not the remote/cached bridge or shared/isolated publication
association; keep the broader coordination and UI checkboxes open until those
remaining original paths are joined and accepted.

## 4. Actual mobile workbench and release

### Cross-process restart admission continuation

See the [original restart admission implementation](../../implementation/2026-10-20-native-workspace-restart-admission.md)
for the durable seal, pre-storage boundary and actual Host-recreation evidence.

Before enabling physical dispatch, seal the server-derived family in the original
reservation transaction. Keep its immutable identity separate from current
approval: revocation does not prove that a native producer drained. Original
Gateway service-only native admission observations must use that durable source,
survive reopen and retain the fence after ownership or approval changes. A live
hold with missing or corrupt membership must fail closed; an unbound namespace
must not be assumed unrelated. Known unrelated project members retain their scope.

Join those observations to the existing reviewed original pre/after-setup hooks,
including resume. Capture original services once, propagate cancellation, never
cache a previous observation or load another runtime. This denies unsafe native
creation after process restart; it is not permission to execute Git. The original
synchronous Gateway authority, exact producer lease, actual native maintenance
handles, root/source association and journal remain required at physical effects.

- Local native hosting is now implemented through the original adapter and a
  protected pipe/socket; see [local transport](../../implementation/2026-10-20-native-git-local-transport.md).
  Shared/isolated publication and actual operator profile acceptance remain
  prerequisites; transport readiness does not open the UI write path.

- [ ] Add execute/current-result/disposition controls to the existing review UI.
  Show exact historical acceptance separately from running/current/unknown state.
  Preserve the original pending request across remount/lost responses and require
  a fresh review for a different mutation. Do not expose a generic Git command.
- [ ] Verify actual React/BFF/Gateway selected staging and unstaging, cancellation,
  ownership revocation, state conflicts, lost HTTP acknowledgement, process loss
  before/after publication and restart. Check actual original index and file bytes.
- [ ] Run appropriate focused/full tests and local builds, source/staged/history
  privacy review, exact scoped commit and remote identity verification. Production
  site stays unchanged. Commit/destructive/revert/remote operations and the full
  26-capability plus portable Chat/Work ledger remain separate open requirements.
