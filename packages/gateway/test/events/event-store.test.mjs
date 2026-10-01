import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProductDatabase, withImmediateTransaction } from '../../src/db/database.ts';
import { EventStore, ExpiredCursorError, FutureCursorError } from '../../src/events/event-store.ts';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'ga-event-'));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv-1', 'user-1', 'ws-1', 't', 'm', 1, 'now', 'now');
  return { directory, db, store: new EventStore(db) };
}

test('append allocates gap-free per-conversation sequence in the caller transaction', () => {
  const { directory, db, store } = setup();
  try {
    const events = withImmediateTransaction(db, () => [
      store.append('conv-1', 'run-1', 'progress.updated', { revision: 1, value: { done: 1 } }),
      store.append('conv-1', 'run-1', 'progress.updated', { revision: 2, value: { done: 2 } }),
    ]);
    assert.deepEqual(events.map(event => event.seq), ['1', '2']);
    assert.equal(store.head('conv-1'), 2);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('replay returns only events after cursor and rejects a future cursor', () => {
  const { directory, db, store } = setup();
  try {
    withImmediateTransaction(db, () => {
      store.append('conv-1', 'run-1', 'goal.updated', { revision: 1, value: {} });
      store.append('conv-1', 'run-1', 'runtime.outcome', { revision: 2, value: {} });
    });
    assert.deepEqual(store.replay('conv-1', 1, 100).map(event => event.seq), ['2']);
    assert.throws(() => store.replay('conv-1', 3, 100), FutureCursorError);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('replay rejects a cursor older than retained events', () => {
  const { directory, db, store } = setup();
  try {
    withImmediateTransaction(db, () => {
      store.append('conv-1', 'run-1', 'goal.updated', { revision: 1, value: {} });
      store.append('conv-1', 'run-1', 'runtime.outcome', { revision: 2, value: {} });
    });
    db.prepare('DELETE FROM ga_events WHERE conversation_id=? AND seq=1').run('conv-1');
    assert.throws(() => store.replay('conv-1', 0, 100), ExpiredCursorError);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test('subscribers are notified after an event is appended and can unsubscribe', async () => {
  const { directory, db, store } = setup();
  let notifications = 0;
  const unsubscribe = store.subscribe('conv-1', () => { notifications += 1; });
  try {
    withImmediateTransaction(db, () => store.append('conv-1', 'run-1', 'progress.updated', { revision: 1 }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notifications, 1);
    unsubscribe();
    withImmediateTransaction(db, () => store.append('conv-1', 'run-1', 'progress.updated', { revision: 2 }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notifications, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});
