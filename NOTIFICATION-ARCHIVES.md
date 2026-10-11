# Cold notification archives

The command below covers notifications and their database snapshot. For the
additional workspace, attachment, runtime and host configuration trees, use the
[offline host backup](HOST-BACKUP.md) procedure with explicit private roots.

## Consistent notification backup and offline restore

The host can create a private SQLite snapshot with every notification archive
referenced by that snapshot. Commands run from the gateway package:

```text
node src/channels/notification-backup-main.ts create DATABASE NEW_PRIVATE_BUNDLE
node src/channels/notification-backup-main.ts verify PRIVATE_BUNDLE TRUSTED_MANIFEST_SHA
node src/channels/notification-backup-main.ts restore PRIVATE_BUNDLE TRUSTED_MANIFEST_SHA NEW_PRIVATE_DIRECTORY
```

Creation uses SQLite's online backup interface, verifies database integrity and
foreign keys, and copies the referenced delivery/digest gzip files. A canonical
manifest records exact byte counts and SHA-256 hashes, with no recipient, message
text or original archive-root path. Keep the returned manifest hash through a
trusted channel independent of the bundle. Verification requires that expected
hash; it does not trust a replacement manifest merely because it matches itself.
Database, manifest and archive changes are rejected. Database hashing uses a
bounded read buffer; each notification archive still has its original size limit.

Restore accepts only an absent private target directory. It verifies the copied
bytes again, then relocates notification archive-root metadata in the **new
offline database copy only**, reinstalls metadata guards and checks all anchors.
It never rewrites the source/live database, overwrites an existing target, clears
deduplication or enables another send. Incomplete output after failure is not a
verified backup and must not be activated as a live database.

This scope validates notification state and cold contents. The SQLite snapshot
contains the entire private product database, so protect it accordingly; it is
not encrypted by these commands. Workspace files, attachments, runtime/session
files and private host configuration outside SQLite are not included. Their
separate backups and relocation acceptance are required for a complete product
restore. Do not start the restored copy as the live product on the strength of
notification-only verification.

No command uploads the bundle. Keep it outside the checkout and any web-served
directory. A private off-site destination and its download/restore evidence must
be configured and verified separately. Local `verified: true` is not a remote
backup receipt and never permits deletion of the only remaining copy.

## Daily local maintenance

The existing harness worker can run bounded cold-archive maintenance. It is off
by default; enabling it is a host configuration decision:

```text
GENERAL_AGENT_NOTIFICATION_ARCHIVE_ENABLED=1
GENERAL_AGENT_NOTIFICATION_ARCHIVE_ROOT=ABSOLUTE_PRIVATE_DIRECTORY
GENERAL_AGENT_NOTIFICATION_ARCHIVE_RETENTION_DAYS=90
GENERAL_AGENT_NOTIFICATION_ARCHIVE_BATCH_SIZE=10
```

Only `0`/blank and `1` are accepted for the switch. An enabled configuration
requires an absolute private archive path. Retention accepts 30–3650 days; page
size accepts 1–25. An invalid configuration fails rather than silently enabling
maintenance. Do not use a web-served or published directory.

Each existing worker maintenance tick processes at most one page. The cursor and
cycle timestamp persist in SQLite and are shared by workers using the same
directory/retention policy. Restart continues the committed page, and a completed
scan waits 24 hours before the next cycle. Source age is checked against the same
cycle timestamp throughout a scan. Keyset pagination follows the live delivery
table; items inserted behind the cursor are considered in the next cycle.
Protected rows advance the cursor without compaction. A complete eligible digest
is archived atomically even if another member falls outside the current page.

Page compaction and its checkpoint commit together. Failure retains the original
hot data/cursor, records a generic failure and backs off one hour; it does not
retry a damaged archive every second. Already archived identities are skipped,
not rearchived or resent. This loop does not delete delivery identities,
authorizations, quota facts, database pages or compressed archive files. A changed
archive root starts a separate policy scan; it never relocates old roots or
rewrites their anchors. Verify database and archive backups before operational
cleanup of any files.

Local tests include the real worker entry point with synthetic, terminal notices
and no model credentials. This is not production scheduling or remote restore
acceptance. Remote verified backups, archive-file expiry and complete product
data retention remain outstanding.

## Complete digest groups

Cold digest maintenance now covers both the separately stored summary text and
every member delivery's body/full receipt:

```text
node src/channels/notification-archive-main.ts archive-digest DATABASE PRIVATE_ARCHIVE_ROOT DIGEST_ID
node src/channels/notification-archive-main.ts restore-digest DATABASE PRIVATE_ARCHIVE_ROOT DIGEST_ID
```

The administrator supplies an existing database and private archive directory.
Archiving requires the complete group to be old and terminal, with no leases,
unknown outcomes or unfinished source occurrences. It verifies the original
summary hash and freezes the member identities and delivery anchors. Summary and
member files are read back and checked before one transaction compacts the group.
A failed summary write rolls back all member indexes and payload changes; files
left by a failed transaction are unregistered orphans, not verified backups.

Digest identity, original summary hash, leader, membership/generation/order and
deduplication facts remain hot. An archived summary stores a content-addressed
marker; reads can reconstruct its exact original text. The normal summary update
guard still rejects arbitrary changes. Only the archive marker or an exact
restore permit prepared in that transaction can change the body; the temporary
restore text is cleared before commit. A legacy worker that recreates the old
unconditional update guard blocks compaction safely. Upgrade/restart all workers
before using these commands.

Restoration verifies the summary and all member anchors, then materializes the
original summary, message bodies and receipts in one transaction. It does not
clear archive identities or requeue delivery. Corrupt files or changed identities
block restoration. CLI output contains opaque IDs and byte counts, never message
bodies or recipient details. This reduces duplicated hot payload storage; it
does not shrink SQLite file pages automatically or establish a production storage
growth rate. Metadata and compressed files still need a retention policy.

Remote backup verification, scheduled maintenance and complete product data
retention remain separate acceptance work. Keep private database/archive files
out of Git, web-served directories and public build outputs.

Notification archive maintenance is an explicit administrator operation. It is
not a browser endpoint, a model tool or an external sending capability. The
default retention window is 90 days; the service permits 30–3650 days. It rejects
nonterminal deliveries, uncertain outcomes, missing confirmation receipts,
active leases, unfinished source runs and incompletely settled digest groups.

The archive contains private message bodies and provider receipt details. Use a
private, access-restricted archive directory and include that directory with the
database in operational backups. Do not place it in a web-served directory or
commit it to a repository. The public ignore rules exclude notification archive
directories and compressed JSON files. Filesystem permissions and backup access
remain the operator's responsibility; gzip is compression, not encryption.

From the gateway package directory, inspect the existing read-only inventory:

```sh
node src/channels/notification-retention-report.ts /private/product.sqlite
```

Archive one eligible effect using its opaque delivery ID:

```sh
node src/channels/notification-archive-main.ts archive /private/product.sqlite /private/notification-archives delivery-id
```

The service writes a content-addressed gzip file, rereads it and validates both
compressed and uncompressed hashes before committing the archive index and
compacting the hot payload fields together. Each archive is limited to 16 MiB
of uncompressed content. It retains the delivery identity, terminal state,
generation, timestamps, source references, authorization and deduplication
records. A minimal provider confirmation stays in the hot record. If the
transaction fails, the original hot content remains; a content-addressed file
may remain unregistered and must not be treated as a verified backup.

Existing delivery reads resolve compacted content without mutating the database
or invoking a provider. Corruption, a missing file, a redirected filesystem path
or a changed hot identity causes an error rather than partial reconstruction.
Archived identities remain excluded from worker claiming even after
materialization; restoration does not authorize another send.

Materialize the original payload and full receipt back into the same database:

```sh
node src/channels/notification-archive-main.ts restore /private/product.sqlite /private/notification-archives delivery-id
```

Restore validates the original hot identity and hashes in a transaction and
changes only payload materialization. Repeated restoration is harmless. The
archive index remains, and its identity and file metadata cannot be edited or
deleted through the maintenance service. Copying a database to a different
archive-root path currently requires a separately reviewed relocation procedure;
the tool will not silently rewrite persisted archive roots.

These are local cold archives. They are not proof of a remote backup, and the
retention inventory continues to protect the hot identity records. No archive
file deletion, automatic scheduled compaction or remote upload is enabled by
these commands. Smaller logical SQLite fields do not mean the database file
has already shrunk: plan any checkpoint or database compaction separately under
the deployment's maintenance constraints.

Tests cover exact restoration, restart/read-through, CLI recovery, corrupt
files, immutable metadata, junction rejection, transaction rollback, protected
digest groups and suppression of archived delivery attempts. Live provider and
production backup/restore acceptance are separate deployment checks.
