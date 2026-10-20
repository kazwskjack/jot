# Original index control IPC and maintenance compatibility

Private continuation of the original index native recovery plan. Preserve DSH,
the original physical DB, owner/review authority, original command/producer facts,
Worker fencing, complete native family and original reservation settlement.
No second planner, registry, scheduler, runtime or receipt store is introduced.
Public index mutation routes/UI are not activated by this increment.

## Historical drain and current authority

Original current-owner journal/API entry points still require the current project
owner. They now delegate immutable fact validation to shared recorded readers;
the same recorded readers validate already-completed native drain after ownership
transfer. Recorded facts are internal evidence, not access rights or execution
authority for either the former or replacement owner. No identity is forged and
no project owner is temporarily changed to make a read pass.

Offline maintenance accepts a genuinely absent original producer finish only
when the existing explicit-control settlement and release are validated against
the same original journal, control receipt, producer and binding. It never adds
or repairs a missing finish. Unresolved holds, any recorded Worker (including
expired), unfinished work, missing proof and rehashed semantic corruption remain
blocking. The preflight still does not observe stopped idle pools or grant
permission to run maintenance against a live service.

## Same authenticated local transport

The existing local transport preserves legacy three-ID index requests and typed
publication commands. A typed `git_index` command carries only the original
`request_id`, `expected_state_sha256` and explicit unknown acknowledgement.
Publication actions/journal digests cannot be used as index controls; unknown
fields, roots, paths, arbitrary commands, runtimes and grants are rejected.
Selectors and command primitives are snapshotted/frozen before awaited I/O.

The original native Host dispatches that command to `resolveReserved`; the
original database/owner/admission/control checks remain in that service. The
Gateway client type is discriminated by operation kind. Transport presence is
not a planning or approval grant, and no automatic retry is added. The owning
Gateway API must ultimately verify original DB status/settlement rather than
interpret peer JSON as delivery acceptance.

## Executed evidence

- Three installed-SDK cases first reproduced maintenance refusing a valid
  completed recovery with absent finish, including ownership transfer.
- Shared historical readers, current-owner denial, exact proof validation and
  offline compatibility passed 31 related tests with no failures/skips, including
  existing original storage/maintenance and schema upgrade regressions.
- An index-control pipe case first failed with the original input rejection.
  After connection, all ten transport tests passed, including authentication,
  immutable command capture, shape separation, cancellation, draining and legacy
  compatibility. The local Gateway build passed.
- Four native-process/client cases passed against the fresh compiled code. The
  original Host executes a reviewed operation, sees parent-side revocation, then
  settles the exact originally admitted control through the same protected pipe.
- Two further real-process cases passed: exit after control receipt but before
  settlement; exit after settlement but before reply. The former keeps the
  original hold and Worker and refuses an immediate retry; only after a fixture
  clock expiry and fresh real cold-storage/native custody can the same command
  finish. The old process was verified dead before that synthetic expiry. This
  is not a timestamp-only production recovery mechanism.
- Restart uses the original persisted Session/family, without constructing a
  replacement Agent or task. Index bytes/inode and original producer/finish rows
  remain unchanged. Acknowledgement replay after settlement writes no database
  data, checked using the observing connection's `data_version`. Model calls are
  zero; the synthetic provider throws on invocation.

Process-exit/pause hooks and recovery-only fixture startup exist only in test
peers. Shipped Host settings accept no such hooks. No production changes, real
provider calls or user data are involved.

## Full gates and remaining scope

The frozen-source candidate is now undergoing full Gateway/root/UI/adapter gates.
Root67 and UI267 passed. Adapter base mode passed823 with29 explicit conditional
skips. A subsequent single-runtime SDK invocation passed843 and failed nine:
the selected main0.2.1 runtime has no optional memory package, and the extraction
loader intentionally requires its separately reviewed Cordis4.0.4/LLM0.2.0-rc.2
runtime plus exact plugin bytes. That raw failure is retained; pins were not
relaxed and failed cases were not removed.

The complete configured-component matrix then passed all852 tests with no
failures/cancellations/skips: native840 on the main0.2.1 runtime and memory12 on
its reviewed0.2.0 runtime. Each adapter test file belongs to exactly one matrix
group; the frozen source hashes are identical. This follows the product's
separate `memoryExtraction.modulesRoot` configuration and does not claim memory
plugin compatibility with an unreviewed SDK or actual-provider acceptance.
The original frozen Gateway gate completed: 2280 tests, 2273 passed, seven
conditional skips, zero failures/cancellations, with source hashes unchanged.
This receipt predates the additional never-started cancellation fix below and
must not be presented as verification of that later source revision.

### Cancellation before original dispatch

A supplemental regression reproduced a missing case: an original UI acceptance
with no reservation, producer or effect records could admit cancellation but
could not complete it without a native Host. The original execution service now
closes that case in its own immediate database transaction. It rechecks current
ownership, original UI admission, exact confirmed request/state digest and
cancellation signal, and records the original `not_dispatched` disposition and
control receipt with cleanup `not_attempted`. It does not create a reservation,
Worker, producer, native family, filesystem effect or synthetic drain proof.

The admitted control already fences original producer start. Any original
reservation, producer, producer finish, preparation, dispatch or outcome keeps
the existing native recovery path. A pending asynchronous producer retains its
original lease; missing Host remains a refusal in that case. Replay after
database reopening returns the validated original receipt without data writes.
Wrong ownership/confirmation and an aborted request cannot close the execution.

Four supplemental regressions passed. Local Gateway typecheck/build, frontend
build and all six publication-verifier tests passed on the revised source.
The subsequent full Gateway gate completed with2284 tests:2276 passed, one
query-only replay failure and seven conditional skips. The branch had acquired
an unnecessary immediate transaction before a validated immutable replay. That
failing source snapshot and its raw receipt are retained separately.

The corrected branch returns a validated immutable replay through reads and
acquires an immediate transaction only for a new disposition, repeating every
original identity/confirmation and never-started fact inside it. Both query-only
SDK replays passed; all eight settlement/unstarted cases passed. The corrected
foundation plus the [HTTP admission/evidence continuation](2026-10-21-index-http-admission-and-evidence.md)
then passed the complete2292-test Gateway gate:2285 passes, seven conditional
skips, zero failures/cancellations,1134 unchanged source files. Root67/UI268,
configured adapter852 without skips and local builds/verifiers passed. These
are the current local candidate receipts; never use the older2280 or failing2284
gate as proof of that revised source, or as full workflow/production acceptance.

Before integration/publication, finish those gates, build locally, verify exact
main-branch baselines and copied sources, and run original disclosure/history
review and non-force remote verification. Keep private snapshots, runtimes,
credentials, DBs and logs out of Git.

Original atomic index admission/status/control HTTP, no-store owner reads,
CSRF/BFF and mobile selection/recovery UI remain to connect. Preserve actual
settlement status separately from physical control completion through reload and
another-device cancellation. This increment does not complete capability15 or
the all26/portable Chat/Work plan; commit/destructive/remote operations and wider
producers/deployment/provider acceptance remain in the original scope.

### Repeating the configured adapter matrix

From the adapter package on Windows, use the same installed native runtime
required by the reviewed native patch and the separate runtime required by
`memory-runtime-loader.js`. The optional plugin must satisfy its byte-hash file;
do not substitute a different version or bypass readiness.

```powershell
$nativeTests = (Get-ChildItem test/*.test.mjs | Where-Object {
  $_.Name -notin @('memory-plugin-runtime.test.mjs', 'memory-runtime-loader.test.mjs')
}).FullName
$env:JOT_DSH_RUNTIME_MODULES = '<native-runtime>/node_modules/@deepseek-ai'
node --test --test-concurrency=2 $nativeTests
$env:JOT_DSH_RUNTIME_MODULES = '<reviewed-memory-runtime>/node_modules/@deepseek-ai'
node --test test/memory-plugin-runtime.test.mjs test/memory-runtime-loader.test.mjs
```

This selector configures local tests; production extraction uses its explicit
optional runtime setting. The test matrix invokes only scripted providers.
