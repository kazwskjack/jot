# Original workspace membership and cold Session exclusion

Status: implemented prerequisites under integration. No Git write route, mobile
execution control or production activation is claimed by this increment. DSH
remains the planner; the original owner, project, Session, run, role, approval and
producer/effect journal remain authoritative.

## Original Gateway family

The existing product database now fences member admission and relocation while
an original project reservation is held. Work/Chat mappings, historical native
run references, checkpoints, Goal controls and native parent/child identities
participate. SQLite `REPLACE` conflicts are checked before insertion, including
unique-key conflicts; an exact stored-row no-op is allowed. Partial indexes do
not make an unrelated queued run conflict with a previous executing run.

Already mapped original inputs can still queue. They cannot create a new native
Session or remap an existing member. Shared-file writes remain fenced by the
original reservation, and unrelated owners/projects retain their own scope.

`GitIndexExecutions.workspaceFamily` derives its inventory from the original
admission, current owner and configured repository binding. It includes archived
and historical references, rejects unbound or foreign identities, and returns no
raw snapshot content or native working directory. The membership digest binds
the reservation and deduplicated Session/conversation/workspace scopes. Adding
an audit reference to an existing member does not change that membership.

The inventory is bounded to 256 members, with 10,000 rows in the original
reference query and separately 10,000 child-reservation rows. Overflow refuses
the operation; it does not silently truncate or certify a larger family.

## Resource custody across ownership and schema upgrades

Ownership revocation must not free a project while its original producer remains
unsettled. Three failing database cases exposed an owner-keyed gap: after project
transfer, a new owner's write could miss the old reservation; a legacy unbound
conversation could change owner out of the family; and an active former-owner
run could be omitted when a new owner tried to reserve that same project.

Known project reservations now follow the original project resource across
ownership changes. Unbound legacy conversations retain conservative owner
scoping, and a held conversation cannot change its owner identity. Original
caller ownership/approval checks remain separate: the new owner cannot adopt,
release or execute the previous owner's operation. Unrelated projects remain
independent. Releasing the resource still requires the original custody and
producer reconciliation; a change of owner is not proof of physical drain.

Previously installed run triggers must actually receive the new SQL; `CREATE
TRIGGER IF NOT EXISTS` alone leaves an old definition active. The original
installer now refreshes changed module-owned definitions in a schema savepoint,
holding the complete installation/rollback boundary. Identical definitions cause
no schema revision change, preserving original immutable-source observations.
Tests reopen the prior owner-only definitions with a held original reservation,
verify that the new owner cannot activate a run, and check rollback of every
changed trigger when installation fails before a corrected retry.

Current resource/upgrade, membership, original HTTP source, legacy migration and
source-revision focused verification: 53 pass, zero failures/skips. Gateway local
typecheck and build pass. The subsequent full Gateway gate on this frozen source
completed with 2,084 tests: 2,077 pass, seven conditional skips, zero failures or
cancellations. Its process exited successfully. Earlier source-cut results below
remain separate evidence, not substitutes for that final gate.

## Original authenticated source channel

The original Gateway registers the service-only POST
`/internal/v1/workbench/git-workspace-source`, sharing the same
`GitIndexExecutions` instance as the historical read routes. It uses the existing
mandatory internal bearer, independently of browser owner/CSRF headers. A request
can select only the original owner, project and admitted execution. The server
rechecks the original approval, live ownership, configured binding and held
reservation before deriving membership. Query parameters, supplied members,
roots, runs and dispatch flags are refused. Responses are private/no-store and
failures contain fixed codes rather than paths or saved content.

`WorkbenchBridge.workspaceFamily` uses that same original authenticated loopback
transport, with a bounded response stream and cancellation. It verifies exact
scope, protocol, member/scoping identities, deduplication, source kinds and the
membership digest, then deeply freezes the result. It neither caches a previous
family after revocation nor resolves any Agent or acquires an execution lease.
This internal channel is not exposed as an Agent tool or a browser BFF operation.

Gateway restart can backfill the existing Work mapping into the mode table. That
adds an audit `source_kind`, but does not add a Session/scope or alter the original
membership digest. The HTTP/restart test verifies that distinction explicitly.

## Resident, stored and absent members

`withNativeWorkspaceBarrier` can retain resident `runMaintenance` handles and
cold original persistence write handles through the same awaited callback.
Every held native cancellation signal reaches inner acquisitions and dispatch.
The original synchronous reservation check must remain valid before and after
awaits. An idle observation or an arbitrary list from a browser is insufficient.

For a stored cold member, `withColdWorkspaceSession` uses the original persistence
`open(id, 'write')` ownership contract. It does not load an Agent, append a prompt
or resume a Goal. It verifies the original current-format header, stable storage
revision, complete log, native invariant replay, inbox/Goal projections and
terminal evidence for background batch operations. Pending input, an active
persisted Goal, unknown tool effects or changed storage keep dispatch closed.
Proofs contain counts and digests, not message text or working directories.

An absent durable log is a different state. `createNativeWorkspaceFactoryGate`
uses the existing reviewed **Jot optional protocol-2 compatibility hooks** around
original setup and publication; these hooks are not advertised as upstream DSH
APIs. The original host claims server-derived member IDs synchronously before
the first storage await. Private, nonserializable hold tokens bind the original
registry, Session store and persistence epoch. A JSON object cannot supply that
authority. Cordis may return different proxies for one service; the original
persistence identity symbol is the service-epoch witness.

Only an authentic held identity plus the original typed not-found error for the
same ID permits absent-member handling. Pending storage and migration-required
logs are not absence. Absence is rechecked before and after the callback, with a
write-open probe that refuses an already preparing writer. The proof explicitly
reports `storage_absent: true`, `storage_owned: false` and null log fields; no
empty event log or fake stored Session is constructed.

Factory shutdown aborts holders but retains hooks until their callbacks drain.
There is no timeout that releases an unknown physical producer. A callback error
or cancellation after dispatch is not proof that filesystem effects did not
happen; the original effect journal must reconcile that separately.

## Verification

- Gateway member/family tests: 18 pass. Original Git/native-child/Chat/Work
  targeted regression from the Gateway working directory: 91 pass. Gateway
  typecheck and build pass. No new full-Gateway result is claimed here.
- Combined family/cold/factory and installed-runtime tests: 39 pass, no skips.
  The installed SDK tests use DSH `0.2.1-rc.2`; only the factory test prepares a
  disposable copy with the already reviewed Jot protocol-2 compatibility delta.
- Actual JSONL storage refuses both native resume and a separate process's
  writer while the original cold write handle is held. Read-only access remains
  possible. The log is unchanged and resume succeeds after release.
- The actual original factory cannot create a held absent ID or publish an
  Agent for it. No model or setup runs for that attempt. After release, ordinary
  creation succeeds. An already preparing original factory retains its writer
  and excludes maintenance rather than being misclassified as absent.
- Full adapter default suite: 779 pass, 28 explicitly conditional skips,
  zero failures/cancellations. Packed adapter loads with the new factory module.
- Full adapter with the new SDK fixture: 798 pass, nine memory-runtime failures,
  zero skips. Those tests require the separately pinned older memory plugin/SDK,
  which this fixture does not contain. This is a recorded mixed-fixture failure,
  not a green full installed-runtime gate or a reason to weaken integrity checks.
- Standalone backend: 67 pass; frontend local build passes. Runtime tests use
  disposable local files and synthetic models, never production conversations.

The subsequent authenticated source-channel checks add 38 passing original
Gateway/member/reservation cases (including five new HTTP cases), four adapter
source cases and a default complete adapter result of 783 pass / 28 conditional
skip / zero failures. The original adapter actually calls the Gateway over
loopback HTTP, and release or approval/owner revocation prevents further source
reads. Original index bytes, leases, producer rows and generic idempotency rows
remain unchanged by inventory reads. Gateway typecheck/build pass. The final
full-Gateway regression is tracked separately while running; the targeted result
must not be described as full-product acceptance.

The current combined installed-native/source verification is 43 pass with zero
failures/skips; the standalone 67 tests, local frontend build and six privacy
scanner regression cases also pass. These checks do not replace the remaining
full-Gateway result or the final source/staged/history publication review.

Final custody review exposed a mutable caller-descriptor edge: deleting the
descriptor's `factoryHold` field after releasing the original hold could make
the subsequent absent-member check skip that hold. A failing reproduction now
passes after capturing the original token once, alongside the other original
dependencies. The final affected adapter verification is 44 combined native/
source cases passing without skips, and 784 passing / 28 conditional skips in
the complete default adapter suite. The separately running Gateway gate retains
its own source-cut evidence; an adapter fix does not turn it into a frozen
all-components acceptance claim.

The first full Gateway run finished with 2,078 total tests: 2,067 pass, four
failures and seven conditional skips. All four failures occurred in tests that
construct historical databases by dropping current columns/tables: SQLite
refused those drops because the newly installed member triggers still referred
to them, before any actual reopen/upgrade ran. The test-only historical-schema
helper now removes only those new triggers, refuses an active reservation and
leaves production migration/permission code unchanged. Each affected fixture
also verifies that reopening reinstalls effective member protection. All eight
tests in the four migration files now pass. A new complete Gateway run is required
and is tracked separately; this targeted fix does not convert the failed full
result into a pass. The complete publishable source scan passes 1,129 files.

## Remaining original-chain integration

The final frozen-source Gateway run completed in 973,019.4979 ms with 2,077
passing tests and seven conditional skips out of 2,084 total. The intermediate
source-cut run had 2,072 pass / seven skips / zero failures out of 2,079; it
preceded the resource and atomic trigger-upgrade additions. Both runs are
distinct from the retained initial 2,078-test failure above. The final gate,
the 53 focused cases, standalone 67 tests and build, default adapter 784 pass /
28 conditional skips, and actual-native/source 44 passing cases establish the
tested increment only. They do not establish production activation, real-model
acceptance, or completion of the remaining original-chain integration below.

The factory gate is host-local. For materialized JSONL logs, original writer
ownership also has kernel-lock evidence. An absent ID has no durable lock file;
the factory gate alone does not exclude another host, an old uncoordinated
process or an unrelated filesystem writer. All original admissions must use the
authoritative host/profile and pre-upgrade producers must drain before activation.

The trusted Gateway inventory now has its authenticated original read channel;
holding that inventory through the original host/producer lifecycle still needs
integration. A successful inventory read is not an asynchronous substitute for
the owning reservation's synchronous dispatch guard. The configured physical Git repository, logical
immutable file store and isolated native working directory are distinct: verify
their real source/publication relationship without substituting a temporary repo
or trusting matching path strings. Verify original run/tool drain and checkpoint
restore; join physical dispatch, journaled results, cancellation, lost responses,
restart and settled/unknown reservation release. Then validate the actual mobile
stage/unstage workflow against original file/index bytes.

Keep the broad coordination checkboxes in the
[HTTP workflow plan](../superpowers/plans/2026-10-19-git-index-http-workflow.md)
open until those actual paths pass. The full PilotDeck capability ledger,
portable Chat/Work, comparison and GitHub release remain in scope.
