import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { installChannelAuthorityMigration } from '../../src/channels/authority-migration.ts';
import { openProductDatabase } from '../../src/db/database.ts';

const M19_BASE = `
  CREATE TABLE ga_channel_threads(
    channel TEXT NOT NULL, principal TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(channel,principal,provider_thread_id));
  CREATE TABLE ga_channel_message_events(
    channel TEXT NOT NULL, principal TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
    provider_message_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
    run_id TEXT NOT NULL, attachments_json TEXT NOT NULL, event_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(channel,principal,provider_thread_id,provider_message_id));`;

function temporary() { return mkdtempSync(join(process.cwd(), '.authority-migration-')); }

function start(path) {
  const db = openProductDatabase(path);
  new OwnerChannelBindings(db, { enabled: ['wecom'] });
  return db;
}

function makeLegacyPopulatedDb(path) {
  const db = start(path);
  db.exec(M19_BASE);
  db.exec(`INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at)
    VALUES('conv-legacy','channel:wecom:principal-a','ws','legacy','{}','now','now');
    INSERT INTO ga_channel_bindings(channel,principal,conversation_id,created_at,updated_at)
    VALUES('wecom','principal-a','conv-legacy','now','now');
    INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at)
    VALUES('legacy-message','conv-legacy','legacy-run','user','complete','{"blocks":[]}','legacy-client','now','now');
    INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at)
    VALUES('legacy-run','conv-legacy','legacy-message','queued',1,'now','now');
    INSERT INTO ga_channel_threads VALUES('wecom','principal-a','thread-a','conv-legacy','now','now');
    INSERT INTO ga_channel_message_events VALUES('wecom','principal-a','thread-a','message-a',
      'conv-legacy','jot-message','jot-run','[]','${'a'.repeat(64)}','now');
    INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,
      status,generation,lease_owner,lease_expires_at,provider_receipt_json,created_at,updated_at)
    VALUES('legacy-file','legacy-run','legacy-message','wecom','principal-a','artifact-old',NULL,
      'pending',0,NULL,NULL,NULL,'now','now'),
      ('legacy-weixin','legacy-run','legacy-message','weixin','principal-b',NULL,'{"kind":"text","text":"hi"}',
       'pending',0,NULL,NULL,NULL,'now','now'),
      ('ordinary-text','legacy-run','legacy-message','email','person@example.test',NULL,'{"kind":"text","text":"hi"}',
       'pending',0,NULL,NULL,NULL,'now','now'),
      ('receipt-only','legacy-run','legacy-message','weixin','principal-b',NULL,NULL,
       'receipt_pending',4,'old-worker',77,'{"provider_message_id":"known"}','now','now'),
      ('unknown','legacy-run','legacy-message','weixin','principal-b',NULL,NULL,
       'outcome_unknown',5,NULL,NULL,'{"provider_message_id":"ambiguous"}','now','now');`);
  return db;
}

function openAndMigrate(path) {
  const db = start(path);
  installChannelAuthorityMigration(db);
  return db;
}

function errorCode(fn, code) {
  assert.throws(fn, error => String(error?.message).includes(code));
}

test('shared migration follows populated product DB startup, pins stay null, old connection is fenced, and second startup is safe', t => {
  const root = temporary();
  const path = join(root, 'm19.sqlite');
  const oldConnection = makeLegacyPopulatedDb(path);
  const handles = [oldConnection];
  t.after(() => { for (const handle of handles) { try { handle.close(); } catch {} } rmSync(root, { recursive: true, force: true }); });

  const db = openAndMigrate(path);
  handles.push(db);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(ga_channel_bindings)').all()
    .map(row => ({ table: row.table, from: row.from, to: row.to, on_delete: row.on_delete })), [
    { table: 'ga_conversations', from: 'conversation_id', to: 'id', on_delete: 'CASCADE' },
  ]);
  for (const table of ['ga_channel_bindings', 'ga_channel_threads', 'ga_channel_message_events']) {
    const row = db.prepare(`SELECT channel_binding_id,binding_version FROM ${table} LIMIT 1`).get();
    assert.equal(row.channel_binding_id, null, `${table} legacy binding ID remains null`);
    assert.equal(row.binding_version, null, `${table} legacy version remains null`);
  }
  assert.deepEqual(db.prepare(`SELECT file_claim_protocol_generation,weixin_claim_protocol_generation
    FROM ga_channel_deliveries ORDER BY effect_id`).all().map(row => ({ ...row })), [
    { file_claim_protocol_generation: 0, weixin_claim_protocol_generation: 0 },
    { file_claim_protocol_generation: 0, weixin_claim_protocol_generation: 0 },
    { file_claim_protocol_generation: 0, weixin_claim_protocol_generation: 0 },
    { file_claim_protocol_generation: 0, weixin_claim_protocol_generation: 0 },
    { file_claim_protocol_generation: 0, weixin_claim_protocol_generation: 0 },
  ]);
  const blockedBefore = oldConnection.prepare(`SELECT effect_id,status,generation,lease_owner,lease_expires_at,
      provider_receipt_json FROM ga_channel_deliveries WHERE effect_id IN ('legacy-file','legacy-weixin') ORDER BY effect_id`)
    .all().map(row => ({ ...row }));

  errorCode(() => oldConnection.prepare(`UPDATE ga_channel_deliveries
    SET status='sending',generation=generation+1 WHERE effect_id='legacy-file'`).run(),
  'channel_file_claim_protocol_required');
  errorCode(() => oldConnection.prepare(`UPDATE ga_channel_deliveries SET status='sending',generation=1,
    file_claim_protocol_generation=1 WHERE effect_id='legacy-file'`).run(),
  'channel_delivery_artifact_pin_required');
  errorCode(() => oldConnection.prepare(`UPDATE ga_channel_deliveries
    SET status='sending',generation=generation+1 WHERE effect_id='legacy-weixin'`).run(),
  'channel_weixin_claim_protocol_required');
  assert.deepEqual(oldConnection.prepare(`SELECT effect_id,status,generation,lease_owner,lease_expires_at,
      provider_receipt_json FROM ga_channel_deliveries WHERE effect_id IN ('legacy-file','legacy-weixin') ORDER BY effect_id`)
    .all().map(row => ({ ...row })), blockedBefore);
  assert.equal(oldConnection.prepare(`UPDATE ga_channel_deliveries
    SET status='sending',generation=generation+1 WHERE effect_id='ordinary-text'`).run().changes, 1);

  const before = db.prepare(`SELECT effect_id,status,generation,lease_owner,lease_expires_at,provider_receipt_json
    FROM ga_channel_deliveries WHERE effect_id IN ('receipt-only','unknown') ORDER BY effect_id`).all();
  assert.deepEqual(before.map(row => row.status), ['receipt_pending', 'outcome_unknown']);
  const firstSql = db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'ga_channel_%' ORDER BY name").all().map(row => ({ ...row }));

  db.close();
  handles.splice(handles.indexOf(db), 1);
  const second = openAndMigrate(path);
  handles.push(second);
  assert.deepEqual(second.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'ga_channel_%' ORDER BY name").all().map(row => ({ ...row })), firstSql);
  assert.deepEqual(second.prepare(`SELECT effect_id,status,generation,lease_owner,lease_expires_at,provider_receipt_json
    FROM ga_channel_deliveries WHERE effect_id IN ('receipt-only','unknown') ORDER BY effect_id`).all(), before);
  assert.equal(second.prepare("SELECT count(*) AS n FROM ga_channel_deliveries WHERE status='outcome_unknown'").get().n, 1);
  assert.equal(second.prepare("SELECT count(*) AS n FROM ga_channel_deliveries WHERE status='receipt_pending'").get().n, 1);
});

test('migration refuses foreign keys disabled before any DDL', t => {
  const root = temporary();
  const db = makeLegacyPopulatedDb(join(root, 'foreign-keys.sqlite'));
  t.after(() => db.close());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  db.exec('PRAGMA foreign_keys=OFF');
  errorCode(() => installChannelAuthorityMigration(db), 'channel_authority_foreign_keys_required');
  assert.equal(db.prepare('PRAGMA table_info(ga_channel_deliveries)').all().some(row => row.name === 'file_claim_protocol_generation'), false);
});

test('malformed preexisting migration object aborts and rolls back every DDL change', t => {
  const root = temporary();
  const db = makeLegacyPopulatedDb(join(root, 'bad-trigger.sqlite'));
  t.after(() => db.close());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  db.exec(`CREATE TRIGGER ga_channel_file_claim_protocol_v1 BEFORE UPDATE ON ga_channel_deliveries
    BEGIN SELECT 1; END;`);
  errorCode(() => installChannelAuthorityMigration(db), 'channel_authority_schema_mismatch');
  for (const [table, column] of [
    ['ga_channel_bindings', 'channel_binding_id'],
    ['ga_channel_threads', 'channel_binding_id'],
    ['ga_channel_message_events', 'channel_binding_id'],
    ['ga_channel_deliveries', 'file_claim_protocol_generation'],
  ]) assert.equal(db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column), false);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='ga_channel_reply_contexts'").get(), undefined);
});

test('malformed preexisting event index aborts and rolls back every DDL change', t => {
  const root = temporary();
  const db = makeLegacyPopulatedDb(join(root, 'bad-index.sqlite'));
  t.after(() => db.close());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  db.exec('CREATE UNIQUE INDEX idx_ga_channel_event_binding_pin ON ga_channel_message_events(provider_message_id)');
  errorCode(() => installChannelAuthorityMigration(db), 'channel_authority_schema_mismatch');
  assert.equal(db.prepare('PRAGMA table_info(ga_channel_message_events)').all().some(row => row.name === 'channel_binding_id'), false);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='ga_channel_poll_cursors'").get(), undefined);
});

test('migration rejects a conversation foreign key attached to channel instead of conversation_id', t => {
  const db = start(':memory:');
  t.after(() => db.close());
  db.exec(`DROP TABLE ga_channel_bindings;
    CREATE TABLE ga_channel_bindings(
      channel TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
      principal TEXT NOT NULL, conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(channel,principal)
    )`);
  assert.equal(db.prepare('PRAGMA foreign_key_list(ga_channel_bindings)').get().from, 'channel');
  errorCode(() => installChannelAuthorityMigration(db), 'channel_authority_schema_mismatch');
  assert.equal(db.prepare('PRAGMA table_info(ga_channel_bindings)').all()
    .some(row => row.name === 'channel_binding_id'), false);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='ga_channel_threads'").get(), undefined);
});

test('migration rejects an existing delivery protocol column with no default', t => {
  const db = makeLegacyPopulatedDb(':memory:');
  t.after(() => db.close());
  db.exec(`DELETE FROM ga_channel_deliveries;
    ALTER TABLE ga_channel_deliveries ADD COLUMN file_claim_protocol_generation INTEGER NOT NULL
      CHECK(file_claim_protocol_generation >= 0)`);
  assert.equal(db.prepare('PRAGMA table_info(ga_channel_deliveries)').all()
    .find(row => row.name === 'file_claim_protocol_generation').dflt_value, null);
  errorCode(() => installChannelAuthorityMigration(db), 'channel_authority_schema_mismatch');
  assert.equal(db.prepare('PRAGMA table_info(ga_channel_deliveries)').all()
    .some(row => row.name === 'weixin_claim_protocol_generation'), false);
});

test('migration accepts only the original zero default for preexisting delivery protocol columns', t => {
  const accepted = makeLegacyPopulatedDb(':memory:');
  t.after(() => accepted.close());
  accepted.exec(`DELETE FROM ga_channel_deliveries;
    ALTER TABLE ga_channel_deliveries ADD COLUMN file_claim_protocol_generation INTEGER NOT NULL DEFAULT 0
      CHECK(file_claim_protocol_generation >= 0)`);
  assert.doesNotThrow(() => installChannelAuthorityMigration(accepted));
  assert.equal(accepted.prepare('PRAGMA table_info(ga_channel_deliveries)').all()
    .find(row => row.name === 'file_claim_protocol_generation').dflt_value, '0');

  const rejected = makeLegacyPopulatedDb(':memory:');
  t.after(() => rejected.close());
  rejected.exec(`DELETE FROM ga_channel_deliveries;
    ALTER TABLE ga_channel_deliveries ADD COLUMN file_claim_protocol_generation INTEGER NOT NULL DEFAULT 1
      CHECK(file_claim_protocol_generation >= 0)`);
  errorCode(() => installChannelAuthorityMigration(rejected), 'channel_authority_schema_mismatch');
  assert.equal(rejected.prepare('PRAGMA table_info(ga_channel_deliveries)').all()
    .find(row => row.name === 'file_claim_protocol_generation').dflt_value, '1');
});

test('migration rejects a case-different owner verified predicate', t => {
  const root = temporary();
  const db = makeLegacyPopulatedDb(join(root, 'case-sensitive-index.sqlite'));
  t.after(() => db.close());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  db.exec(`DROP INDEX ga_owner_channel_principal;
    CREATE UNIQUE INDEX ga_owner_channel_principal ON ga_owner_channel_bindings(channel,principal)
      WHERE status='VERIFIED'`);
  errorCode(() => installChannelAuthorityMigration(db), 'channel_authority_schema_mismatch');
  assert.equal(db.prepare('PRAGMA table_info(ga_channel_deliveries)').all()
    .some(row => row.name === 'file_claim_protocol_generation'), false);
});

test('migration accepts legal SQL whitespace and identifier case in owner index definitions', t => {
  const root = temporary();
  const db = makeLegacyPopulatedDb(join(root, 'case-insensitive-identifiers.sqlite'));
  t.after(() => db.close());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  db.exec(`DROP INDEX ga_owner_channel_principal;
    CREATE UNIQUE INDEX GA_OWNER_CHANNEL_PRINCIPAL ON GA_OWNER_CHANNEL_BINDINGS ( CHANNEL , PRINCIPAL )
      WHERE STATUS = 'verified'`);
  assert.doesNotThrow(() => installChannelAuthorityMigration(db));
});

test('migration rejects sidecar CHECK literals with different SQLite string semantics', t => {
  const source = start(':memory:');
  installChannelAuthorityMigration(source);
  const correctSql = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ga_channel_reply_contexts'").get().sql;
  source.close();

  const db = start(':memory:');
  t.after(() => db.close());
  db.exec(correctSql.replaceAll("'weixin'", "'WEIXIN'").replaceAll("'available'", "'AVAILABLE'"));
  errorCode(() => installChannelAuthorityMigration(db), 'channel_authority_schema_mismatch');
  assert.equal(db.prepare('PRAGMA table_info(ga_channel_deliveries)').all()
    .some(row => row.name === 'file_claim_protocol_generation'), false);
});

test('a comment containing a fake pin CHECK cannot satisfy the migration constraint proof', t => {
  const db = start(':memory:');
  t.after(() => db.close());
  db.exec(`DROP TABLE ga_channel_bindings;
    CREATE TABLE ga_channel_bindings(
      channel TEXT NOT NULL, principal TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, channel_binding_id TEXT,
      binding_version INTEGER -- CHECK(binding_version IS NULL OR binding_version > 0)
      ,PRIMARY KEY(channel,principal)
    )`);
  errorCode(() => installChannelAuthorityMigration(db), 'channel_authority_schema_mismatch');
  assert.equal(db.prepare('PRAGMA table_info(ga_channel_threads)').all().length, 0);
});

test('old candidate context CHECK without fingerprint key ID is rejected and rolled back', t => {
  const root = temporary();
  const db = makeLegacyPopulatedDb(join(root, 'old-context.sqlite'));
  t.after(() => db.close());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  db.exec(`CREATE TABLE ga_channel_reply_contexts(
    channel TEXT NOT NULL,principal TEXT NOT NULL,provider_thread_id TEXT NOT NULL,provider_message_id TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,provider_user_id TEXT NOT NULL,owner_id TEXT NOT NULL,
    channel_binding_id TEXT NOT NULL,binding_version INTEGER NOT NULL,
    state TEXT NOT NULL,context_ciphertext TEXT,context_key_id TEXT,context_fingerprint TEXT,
    context_fingerprint_key_id TEXT,expires_at INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    revoked_at INTEGER,PRIMARY KEY(channel,principal,provider_thread_id,provider_message_id),
    CHECK(state<>'available' OR (context_ciphertext IS NOT NULL AND context_key_id IS NOT NULL
      AND context_fingerprint IS NOT NULL AND expires_at IS NOT NULL)))`);
  errorCode(() => installChannelAuthorityMigration(db), 'channel_authority_schema_mismatch');
  assert.equal(db.prepare('PRAGMA table_info(ga_channel_message_events)').all().some(row => row.name === 'channel_binding_id'), false);
});

test('final context checks require stored fingerprint key IDs and clear all crypto fields in terminal states', t => {
  const db = openProductDatabase(':memory:');
  new OwnerChannelBindings(db, { enabled: ['wecom'] });
  installChannelAuthorityMigration(db);
  t.after(() => db.close());
  db.prepare('INSERT INTO ga_owner_channel_bindings VALUES(?,?,?,?,?,1,?,NULL,?)')
    .run('binding-weixin', 'owner-weixin', 'weixin', 'principal-weixin', 'verified', 10, 10);
  for (const messageId of ['expired-ok', 'revoked-ok', 'available-no-fingerprint-key', 'expired-has-key']) {
    db.prepare(`INSERT INTO ga_channel_message_events(channel,principal,provider_thread_id,provider_message_id,
      conversation_id,message_id,run_id,attachments_json,event_sha256,created_at,channel_binding_id,binding_version)
      VALUES('weixin','principal-weixin','thread-weixin',?,'missing-conversation','message','run','[]',?,
      'now','binding-weixin',1)`).run(messageId, 'a'.repeat(64));
  }
  const insert = db.prepare(`INSERT INTO ga_channel_reply_contexts(channel,principal,provider_thread_id,provider_message_id,
    provider_account_id,provider_user_id,owner_id,channel_binding_id,binding_version,state,context_ciphertext,
    context_key_id,context_fingerprint,context_fingerprint_key_id,expires_at,created_at,updated_at,revoked_at)
    VALUES('weixin','principal-weixin','thread-weixin',?,'account','user','owner-weixin','binding-weixin',1,
    ?,?,?,?,?,?,'now','now',?)`);
  insert.run('expired-ok', 'expired', null, null, null, null, 10, null);
  insert.run('revoked-ok', 'revoked', null, null, null, null, null, 10);
  assert.throws(() => insert.run('available-no-fingerprint-key', 'available', 'cipher', 'enc-key', 'fingerprint', null, 10, null),
    /CHECK constraint failed/);
  assert.throws(() => insert.run('expired-has-key', 'expired', null, null, null, 'fingerprint-key', 10, null),
    /CHECK constraint failed/);
});
