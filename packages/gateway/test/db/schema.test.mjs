import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openProductDatabase, withImmediateTransaction } from '../../src/db/database.ts';

const expectedTables = [
  'ga_projects', 'ga_conversations', 'ga_messages', 'ga_runs', 'ga_run_commands',
  'ga_interactions', 'ga_uploads', 'ga_artifacts', 'ga_artifact_versions',
  'ga_artifact_archives', 'ga_artifact_leases', 'ga_run_artifacts',
  'ga_sources', 'ga_events', 'ga_outbox', 'ga_worker_leases',
  'ga_idempotency', 'ga_runtime_bindings', 'ga_voice_transcriptions',
];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ga-db-'));
  const path = join(directory, 'jot.db');
  const before = new DatabaseSync(path);
  before.exec("CREATE TABLE ai_messages(id INTEGER PRIMARY KEY, content TEXT); INSERT INTO ai_messages(content) VALUES('keep');");
  before.close();
  return { directory, path };
}

test('migration is additive, repeatable, and preserves legacy ai_messages', () => {
  const { directory, path } = fixture();
  try {
    const db = openProductDatabase(path);
    db.close();
    const reopened = openProductDatabase(path);
    try {
      const tables = reopened.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
      for (const name of expectedTables) assert.ok(tables.includes(name), name);
      const legacy = reopened.prepare('SELECT * FROM ai_messages').get();
      assert.equal(legacy.id, 1);
      assert.equal(legacy.content, 'keep');
      assert.equal(reopened.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(reopened.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('artifact archive state is durable and indexed for backup and cleanup scans', () => {
  const { directory, path } = fixture();
  try {
    const db = openProductDatabase(path);
    db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run('conv-archive', 'owner', 'ws', 'archive', 'model', 1, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z');
    db.prepare("INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run('artifact-archive', 'conv-archive', 'owner', 'upload', 1, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z');
    db.prepare(`INSERT INTO ga_artifact_archives(
      artifact_id,backup_status,local_state,remote_path,remote_size,remote_md5,
      attempts,verified_at,last_used_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      'artifact-archive', 'verified', 'present', '/jot_file/2026/09/13/file', 5,
      '0123456789abcdef0123456789abcdef', 1, '2026-09-13T03:00:00.000Z',
      '2026-09-13T04:00:00.000Z', '2026-09-13T00:00:00.000Z', '2026-09-13T04:00:00.000Z',
    );
    db.close();
    const reopened = openProductDatabase(path);
    try {
      const row = reopened.prepare('SELECT * FROM ga_artifact_archives WHERE artifact_id=?').get('artifact-archive');
      assert.equal(row.backup_status, 'verified');
      assert.equal(row.local_state, 'present');
      assert.equal(row.remote_size, 5);
      const indexes = reopened.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(value => value.name);
      assert.ok(indexes.includes('idx_ga_artifact_archives_backup'));
      assert.ok(indexes.includes('idx_ga_artifact_archives_cleanup'));
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('voice ledger persists ownership and request metadata without recording audio or transcript columns', () => {
  const { directory, path } = fixture();
  try {
    const db = openProductDatabase(path);
    const columns = db.prepare('PRAGMA table_info(ga_voice_transcriptions)').all().map(value => value.name);
    assert.ok(columns.includes('owner_id'));
    assert.ok(columns.includes('conversation_id'));
    assert.ok(columns.includes('request_sha256'));
    assert.equal(columns.includes('audio'), false);
    assert.equal(columns.includes('text'), false);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(value => value.name);
    assert.ok(indexes.includes('idx_ga_voice_transcriptions_expiry'));
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('only one active run can exist per conversation', () => {
  const { directory, path } = fixture();
  try {
    const db = openProductDatabase(path);
    db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run('conv-1', 'user-1', 'ws-1', 't', 'm', 1, 'now', 'now');
    const insert = db.prepare("INSERT INTO ga_runs(id,conversation_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?)");
    insert.run('run-1', 'conv-1', 'running', 1, 'now', 'now');
    assert.throws(() => insert.run('run-2', 'conv-1', 'running', 1, 'now', 'now'));
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('immediate transaction commits atomically and rolls back failures', () => {
  const { directory, path } = fixture();
  try {
    const db = openProductDatabase(path);
    assert.throws(() => withImmediateTransaction(db, () => {
      db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run('conv-rollback', 'u', 'w', 't', 'm', 1, 'now', 'now');
      throw new Error('stop');
    }));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ga_conversations WHERE id='conv-rollback'").get().count, 0);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('SQLite writer contention fails within the bounded infrastructure wait without partial writes', () => {
  const { directory, path } = fixture();
  const first = openProductDatabase(path);
  const second = openProductDatabase(path);
  try {
    assert.equal(second.prepare('PRAGMA busy_timeout').get().timeout, 75);
    first.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    assert.throws(() => withImmediateTransaction(second, () => {
      second.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run('must-not-exist', 'u', 'w', 't', '{}', 1, 'now', 'now');
    }), /database is locked/);
    assert.ok(performance.now() - started < 250);
    first.exec('ROLLBACK');
    assert.equal(second.prepare("SELECT COUNT(*) AS count FROM ga_conversations WHERE id='must-not-exist'").get().count, 0);
  } finally {
    if (first.isTransaction) first.exec('ROLLBACK');
    first.close(); second.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
