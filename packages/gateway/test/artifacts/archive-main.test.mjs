import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import { openProductDatabase } from '../../src/db/database.ts';

function fixture() {
  const root = mkdtempSync(fileURLToPath(new URL('./archive-main-fixture-', import.meta.url)));
  const database = join(root, 'db.sqlite');
  const db = openProductDatabase(database);
  function run(mode) {
    return spawnSync(process.execPath, [fileURLToPath(new URL('../../src/artifacts/archive-main.ts', import.meta.url)), mode], {
      encoding: 'utf8', env: { ...process.env, GENERAL_AGENT_DB: database, GENERAL_AGENT_FILE_ROOT: root,
        BAIDUPCS_EXECUTABLE: join(root, 'must-not-run') },
    });
  }
  function artifact() {
    db.prepare(`INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at)
      VALUES('c','o','w','t','m','2026-01-01','2026-01-01')`).run();
    db.prepare(`INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at)
      VALUES('a','c','o','upload',1,'2026-01-01','2026-01-01')`).run();
    db.prepare(`INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at)
      VALUES('a','pending','present','2026-01-01','2026-01-01','2026-01-01')`).run();
  }
  return { root, db, run, artifact, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('archive CLI is silent when archive, restore and cleanup have no work', () => {
  const x = fixture();
  try {
    for (const mode of ['archive','restore','cleanup']) {
      const result = x.run(mode);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
    }
  } finally { x.close(); }
});

test('archive CLI reports failures with nonzero exit and preserves retry scheduling and local state', () => {
  const x = fixture();
  try {
    x.artifact();
    const result = x.run('archive');
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { mode: 'archive', attempted: 1, verified: 0, failed: 1 });
    const row = x.db.prepare('SELECT * FROM ga_artifact_archives').get();
    assert.equal(row.backup_status, 'retry');
    assert.equal(row.local_state, 'present');
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, 'archive_files_missing');
    assert.ok(Date.parse(row.next_retry_at) > Date.now());
    assert.equal(x.run('archive').stdout, '');
  } finally { x.close(); }
});

test('archive CLI retains a summary for actual verified cleanup', () => {
  const x = fixture();
  try {
    x.artifact();
    const directory = join(x.root, 'ready'); mkdirSync(directory);
    const local = join(directory, 'file'); writeFileSync(local, 'hello');
    x.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('a',1,local,createHash('sha256').update('hello').digest('hex'),5,'text/plain',JSON.stringify({file_name:'file',status:'ready'}),'2026-01-01');
    x.db.prepare("UPDATE ga_artifact_archives SET backup_status='verified',remote_md5=?")
      .run(JSON.stringify([{ local_path: local,remote_name:'file',size:5,md5:createHash('md5').update('hello').digest('hex') }]));
    const result = x.run('cleanup');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { mode: 'cleanup', eligible: 1, deleted: 1 });
    assert.equal(existsSync(local), false);
  } finally { x.close(); }
});

test('restore CLI reports verification failures with nonzero exit', () => {
  const x = fixture();
  try {
    x.artifact();
    x.db.prepare("UPDATE ga_artifact_archives SET backup_status='verified',local_state='restoring',remote_path='',remote_md5='[]'").run();
    const result = x.run('restore');
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { mode: 'restore', attempted: 1, restored: 0, failed: 1 });
    assert.equal(x.db.prepare('SELECT last_error FROM ga_artifact_archives').get().last_error, 'archive_restore_manifest_invalid');
  } finally { x.close(); }
});
