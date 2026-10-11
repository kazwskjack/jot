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

Bundles using explicit entries have a version 2 manifest bound to a trusted
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
