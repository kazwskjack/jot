# Offline host backup and recovery

The administrator-only host command includes the product database and six
explicit data classes: database directory, workspaces, artifacts, session/runtime
state, dedicated host configuration and notification archives. It does not scan
your home directory or infer private paths. Include every application's actual
local state directory in the trusted configuration. Files outside these selected
trees, remote-only artifact bodies, other machines and operating-system state
are outside this bundle.

Stop the gateway, all workers, session controller, runtime and other writers
before creating or restoring a bundle. Close/checkpoint separate runtime SQLite
databases through their own service; do not delete WAL or journal files to make a
check pass. `offline: true` is an administrator acknowledgement, not proof that
the command stopped those processes. The product SQLite database uses its backup
API; its raw WAL/SHM are not restored. Other SQLite sidecars cause rejection.

Use a private JSON configuration, for example:

```json
{
  "offline": true,
  "database": "private/host/database/product.sqlite",
  "roots": [
    {"kind": "database", "path": "private/host/database"},
    {"kind": "workspaces", "path": "private/host/workspaces"},
    {"kind": "artifacts", "path": "private/host/artifacts"},
    {"kind": "sessions", "path": "private/host/sessions"},
    {"kind": "host-config", "path": "private/host/config"},
    {"kind": "notification-archives", "path": "private/host/notification-archives"}
  ]
}
```

All six directories must exist, even when a class is empty. Replace these paths
with your deployment's actual directories. Prefer absolute paths; relative paths
resolve against the command's working directory. Nested directories are allowed:
the deepest selected root owns its files, avoiding duplicate copies. Identical
roots for different classes are rejected. The bundle must be outside all sources.

From `packages/gateway`, after building:

```powershell
node dist/src/maintenance/host-backup-main.js create PRIVATE_CONFIG NEW_PRIVATE_BUNDLE
node dist/src/maintenance/host-backup-main.js verify PRIVATE_BUNDLE TRUSTED_SHA
node dist/src/maintenance/host-backup-main.js restore PRIVATE_CONFIG PRIVATE_BUNDLE TRUSTED_SHA
```

The source `.ts` entry also runs on Node 24 for local validation. Successful
commands print only an opaque manifest digest, counts and verified/restored flags.
Keep the returned digest through a separate trusted channel; using a digest
from the same untrusted download does not authenticate a backup.

Creation hashes every file, copies it, verifies copied bytes and checks the source
inventory/database change counter again. It preserves empty directories, rejects
links/junctions and special files, checks SQLite integrity/foreign keys and checks
known artifact/upload/archive references stay inside the selected trees. Locally
present artifact bodies must match their stored hash/size. Notification payloads,
receipts, summary members and immutable anchors are checked against copied archive
bytes, not against files left at the source. Limits are 100,000 inventory entries,
100 directory levels and a 16 MiB manifest; no source is silently truncated.

Restore verifies the trusted digest and all copied bytes before creating targets.
Every full-tree root must be absent and match its original recorded location.
It preserves absolute paths rather than rewriting immutable artifact metadata.
Move a deployment to another machine only when those same absolute paths can be
provided there. Existing data is never overwritten or removed. Failed operations
may leave a partial new bundle/restore tree; quarantine and inspect it before a
fresh attempt. It has no verified receipt and must not be activated.

Restore does not start services, resend notifications, repeat unknown effects,
unlock approvals or reinterpret session checkpoints. Verify the restored services
and their versions while isolated, reconcile unknown effects, then activate through
your deployment procedure. A byte-preserved runtime checkpoint is not proof that
another runtime version can execute it correctly.

Bundles and manifests can contain private conversations, original paths and host
credentials. The bundle is not encrypted by this command. Use private protected
storage and your approved encryption/transfer mechanism. Never commit bundles,
configuration, digests linked to private data or recovered files to GitHub.
Remote storage verification, restore drills and expiry deletion remain separate
deployment checks; this command does not upload or prune anything.

Local synthetic tests cover original-path restore, unknown-state preservation,
missing data classes, existing-target refusal, corruption, omitted external
references, junctions, uncheckpointed runtime files, the CLI, and the actual
Gateway's role/file/upload download with owner isolation. They make no model calls
and do not constitute a production or remote-storage recovery drill.

## Shared directories and explicit entries

A data class can specify a bounded list of literal relative entries when its
parent directory also contains unrelated applications:

```json
{
  "kind": "database",
  "path": "private/shared-state",
  "entries": ["product.sqlite", "legacy-uploads"]
}
```

Each entry selects that file or complete subtree. Empty lists, duplicates,
overlapping entries, traversal, absolute paths and wildcards are not selection
patterns. All entries must exist during creation. The primary database must be
selected, and known stored references must still fall inside a selected entry
or another full data-class root. Selection cannot be used to omit an artifact
referenced by the product database. Ancestor directories and empty directories
are recorded; copied content retains its original relative path.

Windows bundles using explicit entries have a version 2 manifest bound to a trusted
SHA-256 digest, not a digital signature. The verifier
and restore command still accept original version 1 full-tree bundles. Version
2 constrains every manifest file and directory to its recorded selection, and
does not follow selected links, including dangling links. Unrelated siblings
are neither copied nor removed.

Restore may retain an existing shared parent only for an explicit-entry root.
Every selected target must be absent before any restore writes; the primary
database and its WAL, SHM and journal targets must also be absent. Full-tree
roots keep their original absent-root requirement. Existing unrelated parent
contents and permissions are preserved. Never remove a database sidecar while
its writer is running to satisfy this check.

Runtime dependency aliases can remain outside a product-data selection only
when the matching immutable software release, link mapping and configuration
are separately preserved and verified. Do not silently omit linked data or
treat a product-data backup as a complete operating-system/software image.
The offline acknowledgement and stop-all-writers procedure remain required.


## POSIX ownership and permissions

New POSIX backups use a version 3 manifest recording the numeric UID, GID and
all owner/group/other permission bits for every directory and file, including
the original database file rather than the newly created SQLite snapshot.
Private bundle copies remain restricted to the administrator. Restore applies
source ownership before file permissions, then applies directory permissions
from children to parents. Existing shared ancestor directories retain their
current ownership and permissions.

Use this restore on the same host or verify identical account/group mappings
before moving to another host. A POSIX bundle cannot be restored on Windows;
insufficient ownership privileges are rejected before writes. Special mode
bits (setuid, setgid and sticky) are rejected at backup creation rather than
silently changed. Versions 1 and 2 remain readable but do not contain original
POSIX ownership: their successful verification cannot prove service-user access.
A legacy recovery needs an explicitly reviewed ownership procedure.

The regression coverage checks group-readable files, database source modes,
private bundle modes and unchanged shared parents. A separate Linux deployment
probe must also verify that the actual unprivileged service account can open
the restored database and group-readable configuration. Synthetic probes are
not production data recovery acceptance.


## Operational quiescence and migration rehearsal

A successful application test does not establish that a host is offline. Inventory
all processes that hold the selected database, artifact or Session trees, plus
logical producers and the timers that can restart them. Distinguish enabled
periodic monitors from an in-flight execution, and historical outbox records from
the authoritative run queue. Do not delete history to obtain an empty counter.

Record original service/timer states privately. Admit a maintenance window only
with no active foreground runs or execution leases. Stop the writers and their
trigger sources, then inspect file descriptors again before creating a snapshot.
Restore original service states in a failure-safe cleanup path and verify fresh
health checks. Failed or incomplete bundles without a validated manifest are
not recovery points.

Size execution deadlines for the database and every verification pass. The
[Node backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options)
works in batches and exposes progress callbacks. A copied database file alone
does not prove that the application bundle and integrity checks completed. For a
long operation, retain an exact process/start identity and bounded phase records;
observation timeouts must not trigger a duplicate maintenance job.

On Linux, a private mount namespace can rehearse restoration at the original
absolute paths without replacing live host data. Bind private empty parent trees,
restore the verified snapshot, and run the candidate under the actual service
UID/GID. Verify legacy records, schema migration, new owned roles and tasks,
shared workspace access, and unrelated-owner denial. Confirm the host namespace
and its health remained unchanged after the rehearsal. This validates a recovery
candidate; it is not an actual service cutover, host rollback, notification or
provider-execution acceptance. Retain those as separate release gates.
