# Original native Git local transport

The original reviewed index executor now has a local pipe/socket transport
mounted beside the existing DSH Host. Gateway sends only owner, project and
execution IDs after original admission. The native process reads the same
physical product database, holds original maintenance and executes through
`GitIndexExecutions.performReserved`. No additional DSH runtime, planner or task
store is started. No public mutation route or production flag is activated.

## Database and native custody

Gateway's internal `native-git-database` observation requires its own service
bearer, even when browser identity is present. It accepts an empty object without
selectors and returns a physical file digest, never a database path or secret.
This exact internal route bypasses browser CSRF because its mandatory service
authentication is checked by the route itself. It is not unauthenticated.

Both processes retain SQLite main-file canonical path and device/inode identity.
Missing, replaced, hardlinked, symlinked, attached or non-WAL databases refuse
this composition. A copied database is not the same physical database. Before
dispatch, the native process compares its witness with a fresh authenticated
Gateway observation. It repeats the local synchronous check inside the original
native guard throughout effects.

Fixed compiled Gateway modules load relative to this package. Requests cannot
choose modules, database paths, repository roots, native members or an executor.
Constructor initialization runs inside a SQLite transaction and rolls back if
it would change schema or data. The additional process does not install/migrate
the product database.

Adapter `apply` retains the actual pre-storage admission gate and passes that
original reference. Factory, persistence, projections and maintenance handles
belong to the same existing Host. Source/root validation and original ownership,
review, Worker lease, producer, cancellation and outcome checks remain in force.

## Transport and lifecycle

The endpoint is a Windows named pipe or Unix-domain socket, never a TCP listener.
The Unix socket requires an owned canonical private directory and private file
permissions. Windows uses a local named pipe and mandatory application token;
operators protect that token and the service accounts.

Only `POST /execute` with exactly the three identifiers is accepted. A digest
comparison checks authentication. Bodies/responses, connections and incomplete
requests are bounded. A competing request is rejected rather than executing
concurrently. Native errors are redacted. Client disconnect/cancellation reaches
the original operation. Shutdown refuses new work, cancels/drains pending work,
then disposes the original factory and closes its additional DB connection.

A lost response grants no retry. Historical acceptance and current result remain
separate; the original executor retains unknown reservations. This transport
does not infer rollback or release custody on a connection error.

## Operator prerequisites

1. Use the reviewed original runtime with pre-storage/protocol-2 factory
   admission mounted before eager or resident Agents. An ordinary unpatched
   profile is insufficient; use the existing
   [restart admission](2026-10-20-native-workspace-restart-admission.md) workflow.
2. Build Gateway locally so fixed `dist/src` modules exist beside the adapter.
   Do not supply an alternate module loader or another DSH installation.
3. Both services must share the original physical product DB and configured
   checkout. Remote inventory or separate filesystems do not establish custody.
4. In existing operator configuration, enable `nativeWorkspaceAdmission` and
   optionally set `nativeGit` with exactly `databasePath`, `repositories`,
   `socket`, `tokenEnv`. Paths are absolute. Each repository retains original
   `owner_id`, `project_id`, `root`. `tokenEnv` names a `JOT_…` environment
   variable containing a private token of at least 32 characters; never commit
   its value.
5. Choose a unique `jot-git-…` local Windows pipe or private Unix socket. Do not
   proxy it to TCP. Optional Host readiness means the transport mounted, not
   that a user operation is approved or public writes are enabled.

Omitting `nativeGit` preserves the default. Profile generation does not silently
enable or satisfy these deployment prerequisites.

## Verification and remaining work

Actual installed-SDK acceptance uses an original Gateway parent and original
DSH child on a shared temporary DB/checkout. It really stages reviewed bytes.
While the next unstage is preparing, the parent revokes approval; the child
refuses before publication, keeps the index unchanged and retains unresolved
custody. No external model call occurs. The preparation pause is fixture-only.

Focused tests cover authentication, ID-only input, malformed/oversized requests,
redaction, cancellation, shutdown/drain and incomplete bodies. DB tests cover
two connections, file replacement, hardlinks and unavailable connections. The
CSRF-enabled internal route test exposed a missing exact hook entry; it is
corrected while mandatory service authentication remains.

The final SDK-enabled subset passed all 24 cases without skips, including the
separate-process test and original workspace source/admission tests. The adapter
regression passed 814 tests with 29 conditional skips (843 total). Standalone
root tests passed 67 cases and the frontend build. Gateway typecheck/build pass.
The final full Gateway run completed: 2,107 tests, 2,087 passed, 20 conditional
skips, zero failures or cancellations. The tested implementation hashes were
checked again before publication.
Conditional SDK skips are not actual SDK or deployment acceptance.

Still open: shared/isolated publication and checkpoint provenance; interrupted
outcome settlement/reconciliation; original HTTP/BFF/contracts and mobile
execution/disposition; actual profile provisioning and platform/deployment
acceptance. Commit/revert/destructive/remote Git remain separate intents. The
whole 26-capability and portable Chat/Work scope remains open.
