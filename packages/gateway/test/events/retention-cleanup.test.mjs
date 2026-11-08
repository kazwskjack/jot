import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createHostBackup, restoreHostBackup } from '../../src/maintenance/host-backup.ts';
import { buildEventRetentionPlan } from '../../src/events/retention-plan.ts';
import { cleanupEventRetention } from '../../src/events/retention-cleanup.ts';

const scratch = resolve('.test-tmp/retention-cleanup');
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const hostBackupMain = fileURLToPath(new URL('../../src/maintenance/host-backup-main.ts', import.meta.url));
mkdirSync(scratch, { recursive: true });
const now = '2026-10-25T01:00:00.000Z';
const old = '2026-01-01T00:00:00.000Z';
const recent = '2026-10-24T00:00:00.000Z';

async function restoredFixture(t, { active = false, secret = false, failDelete = false, eventType = 'message', restore = true } = {}) {
  const root = mkdtempSync(join(scratch, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  const roots = ['database', 'workspaces', 'artifacts', 'sessions', 'host-config', 'notification-archives']
    .map(kind => ({ kind, path: join(source, kind) }));
  for (const entry of roots) mkdirSync(entry.path);

  const database = join(source, 'database', 'product.sqlite');
  const attachment = join(source, 'artifacts', 'attachment.bin');
  const attachmentBytes = Buffer.from('synthetic attachment bytes');
  writeFileSync(attachment, attachmentBytes);
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
    CREATE TABLE ga_artifact_versions(
      artifact_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, server_path TEXT NOT NULL
    );
    INSERT INTO ga_conversations VALUES('conversation-1', 'owner-1', '${old}');
    INSERT INTO ga_runs VALUES('run-1', 'conversation-1', '${active ? 'running' : 'succeeded'}', '${old}', '${old}');
  `);
  const payloads = [
    secret ? JSON.stringify({ nested: { access_token: 'synthetic-secret-marker' } }) : JSON.stringify({ message: 'old-one' }),
    JSON.stringify({ message: 'old-two' }),
    JSON.stringify({ message: 'recent' }),
  ];
  const insertEvent = db.prepare(`INSERT INTO ga_events
    (conversation_id,seq,event_id,run_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?,?)`);
  insertEvent.run('conversation-1', 1, 'event-1', 'run-1', eventType, payloads[0], old);
  insertEvent.run('conversation-1', 2, 'event-2', 'run-1', 'message', payloads[1], old);
  insertEvent.run('conversation-1', 3, 'event-3', 'run-1', 'message', payloads[2], recent);
  db.prepare('INSERT INTO ga_uploads VALUES(?)').run(attachment);
  db.prepare('INSERT INTO ga_artifact_versions VALUES(?,?,?,?)')
    .run('artifact-1', createHash('sha256').update(attachmentBytes).digest('hex'), attachmentBytes.length, attachment);
  if (failDelete) db.exec(`CREATE TRIGGER synthetic_retention_delete_failure BEFORE DELETE ON ga_events
    WHEN OLD.seq=2 BEGIN SELECT RAISE(ABORT,'synthetic_retention_delete_failure'); END;`);
  db.close();

  const bundle = join(root, 'backup');
  const backup = await createHostBackup({ database, roots, offline: true }, bundle);
  if (!restore) return { root, source, roots, bundle, backup, database, attachment, attachmentBytes };
  renameSync(source, `${source}-parked`);
  const restored = restoreHostBackup(bundle, backup.backup_id, { roots, offline: true });
  assert.equal(restored.restore_verification.restored, true);
  assert.equal(readFileSync(attachment).toString(), attachmentBytes.toString());
  return { root, source, roots, bundle, backup, database, attachment, attachmentBytes,
    restoreVerification: restored.restore_verification };
}

function openDatabase(path) { return new DatabaseSync(path); }
function eventSeqs(db) {
  return db.prepare('SELECT seq FROM ga_events WHERE conversation_id=? ORDER BY seq').all('conversation-1').map(row => Number(row.seq));
}

test('explicit cleanup consumes only a proof-backed same-owner bounded snapshot', async t => {
  const fixture = await restoredFixture(t);
  const db = openDatabase(fixture.database);
  try {
    const report = buildEventRetentionPlan(db, { now, restoreVerification: fixture.restoreVerification });
    const candidate = report.candidates.find(value => value.category === 'ga_events');
    assert.equal(candidate.cleanup_eligible, true);
    assert.equal(candidate.protected, false);
    assert.equal(candidate.deletable, false);
    assert.equal(report.mode, 'dry-run');

    assert.throws(() => cleanupEventRetention(db, {
      ownerId: 'owner-1', conversationId: 'conversation-1', restoreVerification: fixture.restoreVerification,
      maxEvents: 2,
    }), /retention_cleanup_explicit_opt_in_required/);
    assert.throws(() => cleanupEventRetention(db, {
      ownerId: 'other-owner', conversationId: 'conversation-1', explicit: true,
      restoreVerification: fixture.restoreVerification, maxEvents: 2,
    }), /retention_cleanup_owner_scope_mismatch/);
    assert.throws(() => cleanupEventRetention(db, {
      ownerId: 'owner-1', conversationId: 'conversation-1', explicit: true,
      restoreVerification: fixture.restoreVerification, maxEvents: 1,
    }), /retention_cleanup_batch_limit/);
    assert.deepEqual(eventSeqs(db), [1, 2, 3]);

    const result = cleanupEventRetention(db, {
      ownerId: 'owner-1', conversationId: 'conversation-1', explicit: true,
      restoreVerification: fixture.restoreVerification, maxEvents: 2,
    });
    assert.deepEqual(result, { schema_version: 1, deleted_event_count: 2, backup_id: fixture.restoreVerification.backup_id });
  } finally { db.close(); }
  const reopened = new DatabaseSync(fixture.database, { readOnly: true });
  try { assert.deepEqual(eventSeqs(reopened), [3]); } finally { reopened.close(); }
});

test('missing, serialized, secret-bearing, and unfinished evidence stay protected', async t => {
  const plain = await restoredFixture(t);
  const plainDb = openDatabase(plain.database);
  try {
    const unproved = buildEventRetentionPlan(plainDb, { now });
    const unprovedCandidate = unproved.candidates.find(value => value.category === 'ga_events');
    assert.equal(unprovedCandidate.cleanup_eligible, false);
    assert.equal(unprovedCandidate.protected, true);
    assert.throws(() => cleanupEventRetention(plainDb, {
      ownerId: 'owner-1', conversationId: 'conversation-1', explicit: true, maxEvents: 2,
    }), /retention_cleanup_restore_proof_missing/);
    const serializedProof = JSON.parse(JSON.stringify(plain.restoreVerification));
    assert.equal(buildEventRetentionPlan(plainDb, { now, restoreVerification: serializedProof })
      .candidates.find(value => value.category === 'ga_events').cleanup_eligible, false);
    assert.throws(() => cleanupEventRetention(plainDb, {
      ownerId: 'owner-1', conversationId: 'conversation-1', explicit: true,
      restoreVerification: serializedProof, maxEvents: 2,
    }), /retention_cleanup_restore_proof_stale/);
    assert.deepEqual(eventSeqs(plainDb), [1, 2, 3]);
  } finally { plainDb.close(); }

  for (const options of [
    { secret: true }, { active: true }, { eventType: 'private_key' }, { eventType: 'bearer' },
  ]) {
    const fixture = await restoredFixture(t, options);
    const db = openDatabase(fixture.database);
    try {
      const candidate = buildEventRetentionPlan(db, { now, restoreVerification: fixture.restoreVerification })
        .candidates.find(value => value.category === 'ga_events');
      assert.equal(candidate.cleanup_eligible, false);
      assert.equal(candidate.protected, true);
      if (options.eventType) assert.ok(candidate.reasons.includes('secret_log_present'));
      assert.throws(() => cleanupEventRetention(db, {
        ownerId: 'owner-1', conversationId: 'conversation-1', explicit: true,
        restoreVerification: fixture.restoreVerification, maxEvents: 2,
      }), /retention_cleanup_not_eligible/);
      assert.deepEqual(eventSeqs(db), [1, 2, 3]);
      if (options.secret) assert.equal(JSON.stringify(candidate).includes('synthetic-secret-marker'), false);
    } finally { db.close(); }
  }
});

test('stale database or attachment proof cannot authorize cleanup', async t => {
  const fixture = await restoredFixture(t);
  const db = openDatabase(fixture.database);
  try {
    const plan = buildEventRetentionPlan(db, { now, restoreVerification: fixture.restoreVerification });
    assert.equal(plan.candidates.find(value => value.category === 'ga_events').cleanup_eligible, true);
    db.prepare("UPDATE ga_runs SET status='running' WHERE id='run-1'").run();
    assert.throws(() => cleanupEventRetention(db, {
      ownerId: 'owner-1', conversationId: 'conversation-1', explicit: true,
      restoreVerification: fixture.restoreVerification, maxEvents: 2,
    }), /retention_cleanup_restore_proof_stale/);
    assert.deepEqual(eventSeqs(db), [1, 2, 3]);
  } finally { db.close(); }

  const changedAttachment = await restoredFixture(t);
  const changedDb = openDatabase(changedAttachment.database);
  try {
    writeFileSync(changedAttachment.attachment, 'changed synthetic attachment bytes');
    assert.throws(() => cleanupEventRetention(changedDb, {
      ownerId: 'owner-1', conversationId: 'conversation-1', explicit: true,
      restoreVerification: changedAttachment.restoreVerification, maxEvents: 2,
    }), /retention_cleanup_restore_proof_stale/);
    assert.deepEqual(eventSeqs(changedDb), [1, 2, 3]);
  } finally { changedDb.close(); }
});

test('interruption and SQL failure roll back all deletions before reopen', async t => {
  const fixture = await restoredFixture(t);
  const db = openDatabase(fixture.database);
  let checks = 0;
  const interrupted = { get aborted() { checks += 1; return checks >= 4; } };
  try {
    assert.throws(() => cleanupEventRetention(db, {
      ownerId: 'owner-1', conversationId: 'conversation-1', explicit: true,
      restoreVerification: fixture.restoreVerification, maxEvents: 2, signal: interrupted,
    }), /retention_cleanup_interrupted/);
  } finally { db.close(); }
  const afterInterrupt = new DatabaseSync(fixture.database, { readOnly: true });
  try { assert.deepEqual(eventSeqs(afterInterrupt), [1, 2, 3]); } finally { afterInterrupt.close(); }

  const failure = await restoredFixture(t, { failDelete: true });
  const failureDb = openDatabase(failure.database);
  try {
    assert.throws(() => cleanupEventRetention(failureDb, {
      ownerId: 'owner-1', conversationId: 'conversation-1', explicit: true,
      restoreVerification: failure.restoreVerification, maxEvents: 2,
    }), /retention_cleanup_failed/);
  } finally { failureDb.close(); }
  const afterFailure = new DatabaseSync(failure.database, { readOnly: true });
  try { assert.deepEqual(eventSeqs(afterFailure), [1, 2, 3]); } finally { afterFailure.close(); }
});

test('restore cleanup CLI requires opt-in and exact scope before using its in-process restore proof', async t => {
  const fixture = await restoredFixture(t, { restore: false });
  const { bundle, backup } = fixture;
  const config = join(fixture.root, 'private-config.json');
  writeFileSync(config, JSON.stringify({ database: fixture.database, roots: fixture.roots, offline: true }));
  renameSync(fixture.source, `${fixture.source}-parked`);

  const invoke = (ownerId, conversationId, maxEvents, confirm = true) => spawnSync(process.execPath, [
    hostBackupMain, 'restore-cleanup', config, bundle, backup.backup_id,
    ownerId, conversationId, String(maxEvents),
    ...(confirm ? ['--confirm-retention-cleanup'] : []),
  ], { cwd: packageRoot, encoding: 'utf8' });

  assert.equal(invoke('owner-1', 'conversation-1', 2, false).status, 2, 'confirmation is required');
  assert.equal(invoke('', 'conversation-1', 2).status, 2, 'owner scope is required');
  assert.equal(invoke('owner-1', '', 2).status, 2, 'conversation scope is required');
  assert.equal(invoke('owner-1', 'conversation-1', 1001).status, 2, 'batch must stay bounded');
  const externalProof = spawnSync(process.execPath, [hostBackupMain, 'restore-cleanup', config, bundle,
    backup.backup_id, 'owner-1', 'conversation-1', '2', JSON.stringify({ restore_verification: { serialized: true } }),
    '--confirm-retention-cleanup'], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(externalProof.status, 2, 'serialized proof input is unsupported');
  assert.equal(existsSync(fixture.database), false, 'invalid requests must not restore or mutate the database');

  const result = invoke('owner-1', 'conversation-1', 2);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.restored, true);
  assert.equal(receipt.retention_cleanup.deleted_event_count, 2);
  assert.equal(JSON.stringify(receipt).includes(fixture.root), false);
  const db = openDatabase(fixture.database);
  assert.deepEqual(eventSeqs(db), [3]);
  db.close();
  assert.equal(readFileSync(fixture.attachment).toString(), fixture.attachmentBytes.toString());
});
