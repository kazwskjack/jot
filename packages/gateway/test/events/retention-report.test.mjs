import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { openProductDatabase, withImmediateTransaction } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/event-store.ts';

test('standalone inventory opens existing database read-only even while a writer holds a transaction', () => {
  const directory = mkdtempSync(fileURLToPath(new URL('./retention-fixture-', import.meta.url)));
  const path = join(directory, 'db.sqlite');
  const db = openProductDatabase(path);
  const cli = fileURLToPath(new URL('../../src/events/retention-report.ts', import.meta.url));
  try {
    db.prepare(`INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at)
      VALUES('c','o','w','t','m','2026-01-01','2026-01-01')`).run();
    withImmediateTransaction(db, () => new EventStore(db).append('c','r','run.state',{}));
    db.prepare("UPDATE ga_events SET created_at='2026-01-01'").run();
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE ga_conversations SET title='uncommitted'").run();
    const result = spawnSync(process.execPath, [cli,path,'2026-09-20T00:00:00Z'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.candidates[0].protected, true);
    assert.equal(report.candidates[0].event_count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ga_events').get().n, 1);
    db.exec('ROLLBACK');
    const missing = join(directory, 'missing.sqlite');
    assert.notEqual(spawnSync(process.execPath, [cli,missing], { encoding: 'utf8' }).status, 0);
    assert.equal(existsSync(missing), false);
    assert.notEqual(spawnSync(process.execPath, [cli,path,'2026-09-20T00:00:00Z','','1','--execute'], { encoding: 'utf8' }).status, 0);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
