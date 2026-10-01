import assert from 'node:assert/strict';
import test from 'node:test';
import { openProductDatabase, withImmediateTransaction } from '../../src/db/database.ts';
import { EventStore, ExpiredCursorError } from '../../src/events/event-store.ts';
import { buildEventRetentionPlan } from '../../src/events/retention-plan.ts';

const now = '2026-09-20T00:00:00.000Z';
function setup() {
  const db = openProductDatabase(':memory:');
  db.prepare(`INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at)
    VALUES('c','o','w','private title','m','2026-01-01','2026-01-01')`).run();
  db.prepare(`INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at)
    VALUES('r','c','succeeded','2026-01-01','2026-01-01')`).run();
  const store = new EventStore(db);
  withImmediateTransaction(db, () => store.append('c','r','activity.upsert',{ secret: 'private content' }));
  db.prepare("UPDATE ga_events SET created_at='2026-09-12T23:59:59.999Z'").run();
  db.prepare("UPDATE ga_conversations SET updated_at='2026-01-01'").run();
  return { db, store };
}

test('old terminal events and cold sessions remain protected without verified restoration', () => {
  const { db, store } = setup();
  try {
    db.exec('PRAGMA query_only=ON');
    const report = buildEventRetentionPlan(db, { now });
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.candidates.length, 2);
    for (const candidate of report.candidates) {
      assert.equal(candidate.protected, true);
      assert.equal(candidate.deletable, false);
      assert.equal(candidate.backup_verified, false);
    }
    assert.equal(report.candidates[0].event_count, 1);
    assert.ok(report.candidates[0].reasons.includes('complete_checkpoint_and_restore_verification_missing'));
    assert.ok(report.candidates[1].reasons.includes('remote_copy_and_on_demand_restore_unverified'));
    assert.equal(store.replay('c', 0, 10).length, 1);
    assert.equal(store.head('c'), 1);
    assert.equal(JSON.stringify(report).includes('private'), false);
  } finally { db.close(); }
});

test('seven-day boundary is retained and invalid timestamps fail closed', () => {
  const { db } = setup();
  try {
    db.prepare("UPDATE ga_conversations SET updated_at=?").run(now);
    db.prepare("UPDATE ga_events SET created_at='2026-09-13T00:00:00.000Z'").run();
    assert.equal(buildEventRetentionPlan(db, { now }).candidates.length, 0);
    db.prepare("UPDATE ga_events SET created_at='invalid'").run();
    const candidate = buildEventRetentionPlan(db, { now }).candidates[0];
    assert.equal(candidate.protected, true);
    assert.ok(candidate.reasons.includes('event_timestamp_invalid'));
  } finally { db.close(); }
});

test('active and missing runs and runtime bindings are reported as protection reasons', () => {
  const { db } = setup();
  try {
    db.prepare("UPDATE ga_runs SET status='running'").run();
    db.prepare(`INSERT INTO ga_harness_session_bindings VALUES('c','o','session','2026-01-01','2026-01-01')`).run();
    let report = buildEventRetentionPlan(db, { now });
    assert.ok(report.candidates[0].reasons.includes('nonterminal_run_present'));
    assert.ok(report.candidates[1].reasons.includes('runtime_or_channel_binding_present'));
    db.prepare("UPDATE ga_events SET run_id='missing'").run();
    report = buildEventRetentionPlan(db, { now });
    assert.ok(report.candidates[0].reasons.includes('event_run_missing_or_mismatched'));
  } finally { db.close(); }
});

test('pagination is bounded by conversations and rejects invalid scan parameters', () => {
  const { db } = setup();
  try {
    db.prepare(`INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at)
      VALUES('d','o','w','t','m','2026-01-01','2026-01-01')`).run();
    const first = buildEventRetentionPlan(db, { now, limit: 1 });
    assert.equal(first.next_after_conversation_id, 'c');
    const second = buildEventRetentionPlan(db, { now, limit: 1, afterConversationId: first.next_after_conversation_id });
    assert.equal(second.candidates[0].conversation_id, 'd');
    assert.equal(second.next_after_conversation_id, null);
    for (const limit of [0, 1001, 1.5]) assert.throws(() => buildEventRetentionPlan(db, { now, limit }));
    assert.throws(() => buildEventRetentionPlan(db, { now: 'bad' }));
  } finally { db.close(); }
});

test('completely missing event history expires old cursors without resetting sequence', () => {
  const { db, store } = setup();
  try {
    db.prepare('DELETE FROM ga_events').run();
    assert.throws(() => store.replay('c',0,10), ExpiredCursorError);
    assert.deepEqual(store.replay('c',1,10), []);
    const next = withImmediateTransaction(db, () => store.append('c','r','run.state',{}));
    assert.equal(next.seq, '2');
  } finally { db.close(); }
});
