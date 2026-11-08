import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHostBackup, restoreHostBackup } from '../../src/maintenance/host-backup.ts';
import { buildEventRetentionPlan } from '../../src/events/retention-plan.ts';

const scratch = resolve('.test-tmp/retention-restore-proof');
mkdirSync(scratch, { recursive: true });
const now = '2026-10-25T01:00:00.000Z';
const old = '2026-01-01T00:00:00.000Z';
const secretMarker = 'synthetic-private-event-payload';

test('retention consumes a completed restore proof while keeping dry-run and private data protections', async t => {
  const root = mkdtempSync(join(scratch, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  const roots = ['database', 'workspaces', 'artifacts', 'sessions', 'host-config', 'notification-archives']
    .map(kind => ({ kind, path: join(source, kind) }));
  for (const entry of roots) mkdirSync(entry.path);

  const database = join(source, 'database', 'product.sqlite');
  const attachment = join(source, 'artifacts', 'original-attachment.txt');
  writeFileSync(attachment, 'original attachment bytes');
  const db = new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE ga_conversations(id TEXT PRIMARY KEY, owner_id TEXT, updated_at TEXT);
    CREATE TABLE ga_runs(id TEXT PRIMARY KEY, conversation_id TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE ga_events(
      conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
      run_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(conversation_id, seq)
    );
    CREATE TABLE ga_harness_session_bindings(conversation_id TEXT);
    CREATE TABLE ga_channel_bindings(conversation_id TEXT);
    CREATE TABLE ga_uploads(server_path TEXT);
    CREATE TABLE ga_artifact_versions(server_path TEXT);
    INSERT INTO ga_conversations VALUES('conversation-original', 'owner-original', '${old}');
    INSERT INTO ga_runs VALUES('run-original', 'conversation-original', 'succeeded', '${old}', '${old}');
  `);
  db.prepare(`INSERT INTO ga_events
    (conversation_id,seq,event_id,run_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run('conversation-original', 1, 'event-original', 'run-original', 'message', JSON.stringify({ marker: secretMarker }), old);
  const eventQueryPlan = db.prepare(`EXPLAIN QUERY PLAN
    SELECT * FROM ga_events ORDER BY "conversation_id","seq"`).all();
  assert.ok(eventQueryPlan.every(row => !String(row.detail).includes('USE TEMP B-TREE')));
  db.prepare('INSERT INTO ga_uploads VALUES(?)').run(attachment);
  db.prepare('INSERT INTO ga_artifact_versions VALUES(?)').run(attachment);
  db.close();

  const bundle = join(root, 'backup');
  const backup = await createHostBackup({ database, roots, offline: true }, bundle);
  renameSync(source, `${source}-parked`);
  const restored = restoreHostBackup(bundle, backup.backup_id, { roots, offline: true });

  assert.equal(restored.restore_verification.schema_version, 1);
  assert.equal(restored.restore_verification.backup_id, backup.backup_id);
  assert.equal(restored.restore_verification.database_integrity_verified, true);
  assert.equal(restored.restore_verification.reference_paths_verified, true);
  assert.equal(restored.restore_verification.file_contents_verified, true);
  const restoredDatabaseBytes = readFileSync(database);

  const copiedDatabase = join(root, 'same-bytes-other-database.sqlite');
  copyFileSync(database, copiedDatabase);
  const otherDb = new DatabaseSync(copiedDatabase, { readOnly: true });
  try {
    const otherReport = buildEventRetentionPlan(otherDb, { now, restoreVerification: restored.restore_verification });
    const foreignEvent = otherReport.candidates.find(candidate => candidate.category === 'ga_events');
    assert.equal(foreignEvent.backup_verified, false);
    assert.equal(foreignEvent.cleanup_eligible, false);
    assert.equal(foreignEvent.protected, true);
  } finally { otherDb.close(); }

  const restoredDb = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(restoredDb.prepare('SELECT owner_id FROM ga_conversations WHERE id=?')
      .get('conversation-original').owner_id, 'owner-original');
    assert.equal(restoredDb.prepare('SELECT server_path FROM ga_artifact_versions').get().server_path, attachment);
    assert.equal(readFileSync(attachment, 'utf8'), 'original attachment bytes');

    const unproved = buildEventRetentionPlan(restoredDb, { now });
    const event = unproved.candidates.find(candidate => candidate.category === 'ga_events');
    assert.equal(event.backup_verified, false);
    assert.ok(event.reasons.includes('complete_checkpoint_and_restore_verification_missing'));

    const forgedProof = JSON.parse(JSON.stringify(restored.restore_verification));
    const forged = buildEventRetentionPlan(restoredDb, { now, restoreVerification: forgedProof });
    assert.equal(forged.candidates.find(candidate => candidate.category === 'ga_events').backup_verified, false);

    const eventSnapshotQueries = [];
    const tracedDb = {
      get isTransaction() { return restoredDb.isTransaction; },
      exec: restoredDb.exec.bind(restoredDb),
      prepare(sql) {
        if (String(sql).startsWith('SELECT * FROM ga_events ORDER BY')) eventSnapshotQueries.push(String(sql));
        return restoredDb.prepare(sql);
      }
    };
    const report = buildEventRetentionPlan(tracedDb, { now, restoreVerification: restored.restore_verification });
    assert.deepEqual(eventSnapshotQueries, ['SELECT * FROM ga_events ORDER BY "conversation_id","seq"']);
    const verifiedEvent = report.candidates.find(candidate => candidate.category === 'ga_events');
    assert.equal(verifiedEvent.backup_verified, true);
    assert.equal(verifiedEvent.cleanup_eligible, true);
    assert.equal(verifiedEvent.protected, false);
    assert.equal(verifiedEvent.deletable, false);
    assert.deepEqual(verifiedEvent.reasons, []);
    assert.throws(() => buildEventRetentionPlan(restoredDb, {
      now, restoreVerification: restored.restore_verification, restoreProofs: [{ serialized: true }],
    }), /retention_restore_proofs_unsupported/);
    const coldConversation = report.candidates.find(candidate => candidate.category === 'cold_conversation');
    assert.equal(coldConversation.backup_verified, false);
    assert.ok(coldConversation.reasons.includes('remote_copy_and_on_demand_restore_unverified'));
    assert.equal(JSON.stringify(report).includes(secretMarker), false);
  } finally { restoredDb.close(); }

  writeFileSync(attachment, 'changed attachment bytes');
  const attachmentChangedDb = new DatabaseSync(database, { readOnly: true });
  try {
    const changed = buildEventRetentionPlan(attachmentChangedDb, { now, restoreVerification: restored.restore_verification });
    assert.equal(changed.candidates.find(candidate => candidate.category === 'ga_events').backup_verified, false);
  } finally { attachmentChangedDb.close(); }
  writeFileSync(attachment, 'original attachment bytes');

  const walReader = new DatabaseSync(database, { readOnly: true });
  walReader.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get('conversation-original');
  const changedAuthorityDb = new DatabaseSync(database);
  changedAuthorityDb.prepare('UPDATE ga_conversations SET owner_id=? WHERE id=?')
    .run('changed-after-restore', 'conversation-original');
  changedAuthorityDb.close();
  const afterAuthorityChangeDb = new DatabaseSync(database, { readOnly: true });
  try {
    const changed = buildEventRetentionPlan(afterAuthorityChangeDb, { now, restoreVerification: restored.restore_verification });
    assert.equal(changed.candidates.find(candidate => candidate.category === 'ga_events').backup_verified, false);
  } finally { afterAuthorityChangeDb.close(); walReader.close(); }
  writeFileSync(database, restoredDatabaseBytes);

  const changedEventDb = new DatabaseSync(database);
  changedEventDb.prepare('UPDATE ga_events SET payload_json=? WHERE conversation_id=? AND seq=?')
    .run(JSON.stringify({ marker: 'changed-after-restore' }), 'conversation-original', 1);
  changedEventDb.close();
  const afterEventChangeDb = new DatabaseSync(database, { readOnly: true });
  try {
    const changed = buildEventRetentionPlan(afterEventChangeDb, { now, restoreVerification: restored.restore_verification });
    assert.equal(changed.candidates.find(candidate => candidate.category === 'ga_events').backup_verified, false);
  } finally { afterEventChangeDb.close(); }
  writeFileSync(database, restoredDatabaseBytes);

  const newerDb = new DatabaseSync(database);
  newerDb.prepare(`INSERT INTO ga_events
    (conversation_id,seq,event_id,run_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run('conversation-original', 2, 'event-after-restore', 'run-original', 'message', JSON.stringify({ marker: 'post-restore-event' }), old);
  newerDb.close();
  const afterNewEventDb = new DatabaseSync(database, { readOnly: true });
  try {
    const changed = buildEventRetentionPlan(afterNewEventDb, { now, restoreVerification: restored.restore_verification });
    assert.equal(changed.candidates.find(candidate => candidate.category === 'ga_events').backup_verified, false);
  } finally { afterNewEventDb.close(); }
});
