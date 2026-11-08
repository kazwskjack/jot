import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';

import { ArtifactService } from '../../src/artifacts/service.ts';
import { ChannelDeliveryService } from '../../src/channels/delivery.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { canonicalJson } from '../../src/db/canonical-json.ts';
import { openProductDatabase } from '../../src/db/database.ts';
import { installChannelAuthorityMigration } from '../../src/channels/authority-migration.ts';
import {
  proveCachedChannelEvent,
  provePinnedChannelArtifact,
  readVerifiedChannelBinding,
} from '../../src/channels/authority-proofs.ts';

const sha = value => createHash('sha256').update(value).digest('hex');
const pinEffectId = (effect, payload) => 'delivery-' + sha(JSON.stringify([
  'artifact-pin-v1', effect.run_id, effect.message_id, effect.destination,
  effect.recipient, effect.artifact_ref, sha(canonicalJson(payload)),
])).slice(0, 32);

function fixture(t) {
  const root = mkdtempSync(join(process.cwd(), '.channel-authority-proof-'));
  const workspace = resolve(process.cwd());
  const fixtureRoot = resolve(root);
  if (fixtureRoot !== workspace && !fixtureRoot.startsWith(workspace + sep)) {
    throw new Error('channel_authority_fixture_path_invalid');
  }
  const db = openProductDatabase(':memory:');
  new OwnerChannelBindings(db, { enabled: ['wecom'] });
  installChannelAuthorityMigration(db);
  const artifacts = new ArtifactService(db, join(root, 'artifacts'));
  const delivery = new ChannelDeliveryService(db, () => 1000);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, root, artifacts, delivery };
}

function binding(db, ownerId, principal = 'provider-user', bindingId = 'binding-a') {
  db.prepare('INSERT INTO ga_owner_channel_bindings VALUES(?,?,?,?,?,1,?,NULL,?)')
    .run(bindingId, ownerId, 'wecom', principal, 'verified', 1000, 1000);
  return { channel_binding_id: bindingId, binding_version: 1 };
}

function conversationRun(db, { ownerId = 'owner-a', conversationId = 'conv-a', runId = 'run-a', messageId = 'message-a', inputText = 'hello' } = {}) {
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(conversationId, ownerId, 'ws', 'title', '{}', 1, 'now', 'now');
  const content = JSON.stringify({ blocks: [{ block_id: `${messageId}:0`, kind: 'text', text: inputText }], attachments: [] });
  db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(messageId, conversationId, runId, 'user', 'complete', content, 'client-' + messageId, 'now', 'now');
  db.prepare('INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(runId, conversationId, messageId, 'queued', 1, 'now', 'now');
  return { owner_id: ownerId, conversation_id: conversationId, run_id: runId, message_id: messageId };
}

function transaction(db, callback) {
  db.exec('BEGIN');
  try { return callback(); } finally { db.exec('ROLLBACK'); }
}

function eventIdentity({ channel = 'wecom', principal = 'provider-user', threadId = 'thread-a', messageId = 'provider-message-a', text = 'hello', attachments = [] } = {}) {
  return { channel, principal, threadId, messageId, text, attachments };
}

function cacheEvent(db, identity, scope = conversationRun(db, { inputText: identity.text })) {
  const authority = db.prepare(`SELECT channel_binding_id,version FROM ga_owner_channel_bindings
    WHERE channel=? AND principal=? AND status='verified'`).get(identity.channel, identity.principal);
  if (!authority) throw new Error('fixture_binding_missing');
  const attachmentJson = JSON.stringify(identity.attachments);
  const eventHash = sha(JSON.stringify({ channel: identity.channel, principal: identity.principal,
    threadId: identity.threadId, messageId: identity.messageId, text: identity.text,
    attachments: identity.attachments }));
  if (identity.threadId) {
    db.prepare(`INSERT INTO ga_channel_threads(channel,principal,provider_thread_id,conversation_id,created_at,updated_at,
      channel_binding_id,binding_version) VALUES(?,?,?,?,?,?,?,?)`)
      .run(identity.channel, identity.principal, identity.threadId, scope.conversation_id, 'now', 'now',
        authority.channel_binding_id, authority.version);
  } else {
    db.prepare(`INSERT INTO ga_channel_bindings(channel,principal,conversation_id,created_at,updated_at,
      channel_binding_id,binding_version) VALUES(?,?,?,?,?,?,?)`)
      .run(identity.channel, identity.principal, scope.conversation_id, 'now', 'now',
        authority.channel_binding_id, authority.version);
  }
  db.prepare(`INSERT INTO ga_channel_message_events(channel,principal,provider_thread_id,provider_message_id,
    conversation_id,message_id,run_id,attachments_json,event_sha256,created_at,channel_binding_id,binding_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(identity.channel, identity.principal, identity.threadId, identity.messageId,
      scope.conversation_id, scope.message_id, scope.run_id, attachmentJson, eventHash, 'now',
      authority.channel_binding_id, authority.version);
  return { event_sha256: eventHash, attachments_json: attachmentJson, ...scope };
}

function pinArtifact(db, delivery, effect, payload) {
  const effectId = pinEffectId(effect, payload);
  db.prepare(`INSERT INTO ga_channel_deliveries(
    effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,generation,
    lease_owner,lease_expires_at,created_at,updated_at,file_claim_protocol_generation
  ) VALUES(?,?,?,?,?,?,?,'sending',1,'proof-worker',9999,'now','now',1)`)
    .run(effectId, effect.run_id, effect.message_id, effect.destination,
      effect.recipient, effect.artifact_ref, JSON.stringify(payload));
  return effectId;
}

function onePartManifest(displayName, mimeType, bytes) {
  return [{ part_index: 1, display_name: displayName, sha256: sha(bytes),
    size_bytes: Buffer.byteLength(bytes), mime_type: mimeType }];
}

function filePin({ ownerId, conversationId, artifactId, version, bytes, manifest }) {
  return { kind: 'artifact', schema_version: 1, owner_id: ownerId,
    conversation_id: conversationId, artifact_id: artifactId, version,
    sha256: sha(bytes), size_bytes: Buffer.byteLength(bytes),
    manifest_sha256: sha(canonicalJson(manifest)), manifest };
}

test('verified owner lookup requires an active database transaction and exact principal binding', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  assert.throws(() => readVerifiedChannelBinding(f.db, 'wecom', 'provider-user'), /channel_authority_transaction_required/);
  const proof = transaction(f.db, () => readVerifiedChannelBinding(f.db, 'wecom', 'provider-user'));
  assert.deepEqual(proof, { channel_binding_id: 'binding-a', owner_id: 'owner-a',
    channel: 'wecom', principal: 'provider-user', version: 1 });
});

test('verified owner lookup fails closed when the provider principal has no owner binding', t => {
  const f = fixture(t);
  assert.throws(() => transaction(f.db, () => readVerifiedChannelBinding(f.db, 'wecom', 'provider-user')),
    /channel_authority_binding_missing/);
});

test('verified owner lookup queries a composite provider principal and fails closed when it is unbound', t => {
  const f = fixture(t), principal = JSON.stringify(['bot-a', 'unbound-user']);
  assert.throws(() => transaction(f.db, () => readVerifiedChannelBinding(f.db, 'wecom', principal)),
    /channel_authority_binding_missing/);
});

test('verified owner lookup refuses duplicate current rows even if the uniqueness index is damaged', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  f.db.exec('DROP INDEX ga_owner_channel_principal');
  binding(f.db, 'owner-b', 'provider-user', 'binding-b');
  assert.throws(() => transaction(f.db, () => readVerifiedChannelBinding(f.db, 'wecom', 'provider-user')),
    /channel_authority_binding_ambiguous/);
});

test('cached thread event returns only after owner, event digest, thread, message and run links agree', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const identity = eventIdentity(), cached = cacheEvent(f.db, identity);
  const before = f.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n;
  const proof = transaction(f.db, () => proveCachedChannelEvent(f.db, identity));
  assert.equal(proof.run_id, cached.run_id);
  assert.equal(proof.owner_id, 'owner-a');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_message_events').get().n, before);
});

test('cached event rejects the same run and message IDs when the stored M19 text differs from the provider event', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const identity = eventIdentity({ text: 'provider text' });
  const scope = conversationRun(f.db, { inputText: 'different stored text' });
  cacheEvent(f.db, identity, scope);
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, identity)),
    /channel_cached_event_message_mismatch/);
});

test('same provider principal rebound to owner B cannot return owner A cached thread or event', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const identity = eventIdentity(), cached = cacheEvent(f.db, identity);
  f.db.prepare("UPDATE ga_owner_channel_bindings SET status='revoked',version=2,revoked_at=1001 WHERE channel_binding_id='binding-a'").run();
  binding(f.db, 'owner-b', 'provider-user', 'binding-b');
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, identity)), /channel_cached_event_binding_mismatch/);
  assert.equal(cached.owner_id, 'owner-a');
});

test('same-owner revoke and rebind cannot replay an event pinned to the previous binding ID', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const identity = eventIdentity(); cacheEvent(f.db, identity);
  f.db.prepare("UPDATE ga_owner_channel_bindings SET status='revoked',version=2,revoked_at=1001 WHERE channel_binding_id='binding-a'").run();
  binding(f.db, 'owner-a', 'provider-user', 'binding-rebound');
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, identity)), /channel_cached_event_binding_mismatch/);
});

test('cached event refuses changed identity, changed thread mapping and metadata-only attachments', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const identity = eventIdentity(); cacheEvent(f.db, identity);
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, { ...identity, text: 'changed' })), /channel_cached_event_source_mismatch/);
  f.db.prepare("UPDATE ga_channel_threads SET conversation_id='foreign-conv' WHERE provider_thread_id='thread-a'").run();
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, identity)), /channel_cached_thread_mismatch/);
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db,
    { ...identity, attachments: [{ provider_file_id: 'file-a', file_name: 'a.pdf', media_type: 'application/pdf' }] })),
  /channel_attachment_staging_missing/);
});

test('cached event requires matching binding-generation pins on both thread and event rows', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const identity = eventIdentity(); cacheEvent(f.db, identity);
  f.db.prepare(`UPDATE ga_channel_message_events SET binding_version=2
    WHERE provider_message_id=?`).run(identity.messageId);
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, identity)),
    /channel_cached_event_binding_mismatch/);
  f.db.prepare(`UPDATE ga_channel_message_events SET binding_version=1 WHERE provider_message_id=?`)
    .run(identity.messageId);
  f.db.prepare(`UPDATE ga_channel_threads SET channel_binding_id='binding-old'
    WHERE provider_thread_id=?`).run(identity.threadId);
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, identity)),
    /channel_cached_thread_mismatch/);
});

test('cached event refuses missing pins and broken run/message input links', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const identity = eventIdentity(); cacheEvent(f.db, identity);
  f.db.prepare(`UPDATE ga_channel_message_events SET binding_version=NULL WHERE provider_message_id=?`)
    .run(identity.messageId);
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, identity)), /channel_cached_event_binding_mismatch/);
  f.db.prepare(`UPDATE ga_channel_message_events SET binding_version=1,channel_binding_id=NULL WHERE provider_message_id=?`)
    .run(identity.messageId);
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, identity)), /channel_cached_event_binding_mismatch/);
  f.db.prepare(`UPDATE ga_channel_message_events SET channel_binding_id='binding-a' WHERE provider_message_id=?`)
    .run(identity.messageId);
  f.db.prepare(`INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at)
    VALUES('other-message','conv-a','run-a','user','complete','{"blocks":[]}','client-other','now','now')`).run();
  f.db.prepare("UPDATE ga_runs SET input_message_id='other-message' WHERE id='run-a'").run();
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, identity)), /channel_cached_event_link_mismatch/);
  f.db.prepare("UPDATE ga_runs SET input_message_id='message-a' WHERE id='run-a'").run();
  f.db.prepare("UPDATE ga_messages SET status='failed' WHERE id='message-a'").run();
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, identity)), /channel_cached_event_link_mismatch/);
});

test('direct cached event requires the root map to carry the current binding generation', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const identity = eventIdentity({ threadId: '' }); cacheEvent(f.db, identity);
  assert.equal(transaction(f.db, () => proveCachedChannelEvent(f.db, identity)).run_id, 'run-a');
  f.db.prepare("UPDATE ga_channel_bindings SET binding_version=2 WHERE channel='wecom' AND principal='provider-user'").run();
  assert.throws(() => transaction(f.db, () => proveCachedChannelEvent(f.db, identity)), /channel_cached_thread_mismatch/);
});

test('pinned task output proof returns verified copied bytes and rejects a legacy unpinned effect', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const scope = conversationRun(f.db, { runId: 'run-file', messageId: 'message-file' });
  const bytes = Buffer.from('reviewed report');
  const filePath = join(f.root, 'task-output.txt'); writeFileSync(filePath, bytes);
  const artifactId = 'artifact-file', now = 'now', digest = sha(bytes);
  const manifest = [{ part_index: 1, display_name: 'report.txt', sha256: digest,
    size_bytes: bytes.length, mime_type: 'text/plain' }];
  f.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(artifactId, scope.conversation_id, scope.owner_id, 'task_output_file', 1, now, now);
  f.db.prepare('INSERT INTO ga_artifact_versions VALUES(?,?,?,?,?,?,?,?)')
    .run(artifactId, 1, filePath, digest, bytes.length, 'text/plain', JSON.stringify({
      file_name: 'report.txt', status: 'ready', origin: 'generated', preview_kind: 'text',
      task_file: { run_id: scope.run_id, receipt_id: 'receipt-a', sha256: digest },
    }), now);
  const v2 = Buffer.from('replacement version');
  const filePath2 = join(f.root, 'task-output-v2.txt'); writeFileSync(filePath2, v2);
  f.db.prepare('INSERT INTO ga_artifact_versions VALUES(?,?,?,?,?,?,?,?)')
    .run(artifactId, 2, filePath2, sha(v2), v2.length, 'text/plain', JSON.stringify({
      file_name: 'report-v2.txt', status: 'ready', origin: 'generated', preview_kind: 'text',
      task_file: { run_id: scope.run_id, receipt_id: 'receipt-a-v2', sha256: sha(v2) },
    }), now);
  f.db.exec('DROP TRIGGER ga_task_output_no_identity_update');
  f.db.prepare('UPDATE ga_artifacts SET current_version=2 WHERE id=?').run(artifactId);
  f.db.prepare('INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(artifactId, 'pending', 'present', now, now, now);
  f.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)')
    .run(scope.run_id, artifactId, 1, now);
  const effect = { ...scope, destination: 'wecom', recipient: 'provider-user', artifact_ref: artifactId };
  const payload = filePin({ ownerId: scope.owner_id, conversationId: scope.conversation_id,
    artifactId, version: 1, bytes, manifest });
  const effectId = pinArtifact(f.db, f.delivery, effect, payload);
  const proof = transaction(f.db, () => provePinnedChannelArtifact(f.db, f.delivery, f.artifacts, effectId));
  assert.equal(proof.version, 1);
  assert.equal(proof.owner_id, 'owner-a');
  assert.deepEqual(proof.parts[0].content, bytes);
  proof.parts[0].content[0] ^= 0xff;
  assert.deepEqual(f.artifacts.download(artifactId, 'owner-a', 1).verified_content, bytes);
  assert.deepEqual(f.artifacts.download(artifactId, 'owner-a', 2).verified_content, v2);
  writeFileSync(filePath, 'tampered bytes');
  assert.throws(() => transaction(f.db, () => provePinnedChannelArtifact(f.db, f.delivery, f.artifacts, effectId)),
    /channel_artifact_content_mismatch/);
  writeFileSync(filePath, bytes);

  const legacy = { ...effect, message_id: 'message-legacy', artifact_ref: artifactId };
  conversationRun(f.db, { conversationId: 'conv-legacy', runId: 'run-legacy', messageId: legacy.message_id });
  const oldId = 'delivery-' + sha(JSON.stringify([legacy.run_id, legacy.message_id,
    legacy.destination, legacy.recipient, artifactId, null])).slice(0, 32);
  f.db.prepare(`INSERT INTO ga_channel_deliveries(
    effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,generation,
    lease_owner,lease_expires_at,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,NULL,'sending',1,'proof-worker',9999,'now','now')`)
    .run(oldId, legacy.run_id, legacy.message_id, legacy.destination, legacy.recipient, artifactId);
  assert.throws(() => transaction(f.db, () => provePinnedChannelArtifact(f.db, f.delivery, f.artifacts, oldId)),
    /channel_delivery_artifact_(authority_missing|claim_unverified)/);
});

test('pinned generated group keeps reading its pinned version after current_version changes', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const scope = conversationRun(f.db, { runId: 'run-group', messageId: 'message-group' });
  const source = join(f.root, 'part.pdf'), bytes = Buffer.from('synthetic-pdf-bytes');
  writeFileSync(source, bytes);
  const group = f.artifacts.registerGenerated(scope.run_id, 'runtime-group-a',
    [{ path: source, display_name: 'volume.pdf' }]);
  const artifactId = group.artifact_ref;
  f.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)')
    .run(scope.run_id, artifactId, 1, 'now');
  const manifest = group.parts.map(part => ({ part_index: Number(part.part_index),
    display_name: String(part.display_name), sha256: String(part.sha256),
    size_bytes: Number(part.size_bytes), mime_type: String(part.mime_type) }));
  const payload = { kind: 'artifact', schema_version: 1, owner_id: scope.owner_id,
    conversation_id: scope.conversation_id, artifact_id: artifactId, version: 1,
    sha256: group.sha256, size_bytes: group.size_bytes,
    manifest_sha256: sha(canonicalJson(manifest)), manifest };
  const effect = { ...scope, destination: 'wecom', recipient: 'provider-user', artifact_ref: artifactId };
  const effectId = pinArtifact(f.db, f.delivery, effect, payload);
  f.db.prepare('UPDATE ga_artifacts SET current_version=2 WHERE id=?').run(artifactId);
  const proof = transaction(f.db, () => provePinnedChannelArtifact(f.db, f.delivery, f.artifacts, effectId));
  assert.equal(proof.version, 1);
  assert.deepEqual(proof.parts.map(part => part.content), [bytes]);
});

test('pinned generated group rejects changed part bytes even when the snapshot is unchanged', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const scope = conversationRun(f.db, { runId: 'run-tamper', messageId: 'message-tamper' });
  const source = join(f.root, 'part.docx'), bytes = Buffer.from('synthetic-docx-bytes'); writeFileSync(source, bytes);
  const group = f.artifacts.registerGenerated(scope.run_id, 'runtime-group-tamper',
    [{ path: source, display_name: 'volume.docx' }]);
  f.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)')
    .run(scope.run_id, group.artifact_ref, 1, 'now');
  const part = group.parts[0];
  const manifest = [{ part_index: 1, display_name: String(part.display_name), sha256: String(part.sha256),
    size_bytes: Number(part.size_bytes), mime_type: String(part.mime_type) }];
  const payload = { kind: 'artifact', schema_version: 1, owner_id: scope.owner_id,
    conversation_id: scope.conversation_id, artifact_id: group.artifact_ref, version: 1,
    sha256: group.sha256, size_bytes: group.size_bytes,
    manifest_sha256: sha(canonicalJson(manifest)), manifest };
  const effect = { ...scope, destination: 'wecom', recipient: 'provider-user', artifact_ref: group.artifact_ref };
  const effectId = pinArtifact(f.db, f.delivery, effect, payload);
  writeFileSync(String(part.server_path), 'tampered bytes');
  assert.throws(() => transaction(f.db, () => provePinnedChannelArtifact(f.db, f.delivery, f.artifacts, effectId)),
    /channel_artifact_content_mismatch/);
});

test('pinned artifact rejects modified manifest and content-addressed effect identity', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const scope = conversationRun(f.db, { runId: 'run-manifest', messageId: 'message-manifest' });
  const bytes = Buffer.from('one file');
  const path = join(f.root, 'manifest.txt'); writeFileSync(path, bytes);
  const digest = sha(bytes), artifactId = 'artifact-manifest', now = 'now';
  f.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(artifactId, scope.conversation_id, scope.owner_id, 'task_output_file', 1, now, now);
  f.db.prepare('INSERT INTO ga_artifact_versions VALUES(?,?,?,?,?,?,?,?)')
    .run(artifactId, 1, path, digest, bytes.length, 'text/plain', JSON.stringify({ file_name: 'manifest.txt',
      status: 'ready', origin: 'generated', task_file: { run_id: scope.run_id } }), now);
  f.db.prepare('INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(artifactId, 'pending', 'present', now, now, now);
  f.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)')
    .run(scope.run_id, artifactId, 1, now);
  const effect = { ...scope, destination: 'wecom', recipient: 'provider-user', artifact_ref: artifactId };
  const manifest = onePartManifest('manifest.txt', 'text/plain', bytes);
  const payload = filePin({ ownerId: scope.owner_id, conversationId: scope.conversation_id,
    artifactId, version: 1, bytes, manifest });
  const effectId = pinArtifact(f.db, f.delivery, effect, payload);
  f.db.prepare('UPDATE ga_channel_deliveries SET payload_json=? WHERE effect_id=?')
    .run(JSON.stringify({ ...payload, unexpected: true }), effectId);
  assert.throws(() => transaction(f.db, () => provePinnedChannelArtifact(f.db, f.delivery, f.artifacts, effectId)),
    /channel_delivery_artifact_pin_invalid/);
  f.db.prepare('UPDATE ga_channel_deliveries SET payload_json=? WHERE effect_id=?')
    .run(JSON.stringify(payload), effectId);
  const changed = { ...payload, manifest: [{ ...manifest[0], size_bytes: manifest[0].size_bytes + 1 }] };
  f.db.prepare('UPDATE ga_channel_deliveries SET payload_json=? WHERE effect_id=?')
    .run(JSON.stringify(changed), effectId);
  assert.throws(() => transaction(f.db, () => provePinnedChannelArtifact(f.db, f.delivery, f.artifacts, effectId)),
    /channel_delivery_(artifact_pin_invalid|source_mismatch)/);
  f.db.prepare('UPDATE ga_channel_deliveries SET payload_json=? WHERE effect_id=?')
    .run(JSON.stringify(payload), effectId);
  f.db.prepare('UPDATE ga_channel_deliveries SET effect_id=? WHERE effect_id=?')
    .run('delivery-' + '0'.repeat(32), effectId);
  assert.throws(() => transaction(f.db, () => provePinnedChannelArtifact(f.db, f.delivery, f.artifacts, 'delivery-' + '0'.repeat(32))),
    /channel_delivery_source_mismatch/);
});

test('pinned artifact proof rejects an ArtifactService backed by another database handle', t => {
  const f = fixture(t); binding(f.db, 'owner-a');
  const otherDb = openProductDatabase(':memory:');
  const otherArtifacts = new ArtifactService(otherDb, join(f.root, 'other-artifacts'));
  t.after(() => otherDb.close());
  assert.throws(() => transaction(f.db, () => provePinnedChannelArtifact(f.db, f.delivery, otherArtifacts, 'missing-effect')),
    /channel_authority_database_mismatch/);
});
