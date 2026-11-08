import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ArtifactService } from '../../src/artifacts/service.ts';
import { ChannelDeliveryService } from '../../src/channels/delivery.ts';
import { ChannelDeliveryWorker } from '../../src/channels/worker.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { installChannelAuthorityMigration } from '../../src/channels/authority-migration.ts';
import { canonicalJson } from '../../src/db/canonical-json.ts';
import { openProductDatabase } from '../../src/db/database.ts';
import { withImmediateTransaction } from '../../src/db/database.ts';
import { provePendingPinnedChannelArtifact } from '../../src/channels/authority-proofs.ts';
import { TaskNotifications } from '../../src/persistent-tasks/notifications.ts';

const sha = value => createHash('sha256').update(value).digest('hex');
const mattermostAccount={instance:'https://chat.example.test',botUserId:'bot-account'};
const mattermostPrincipal=JSON.stringify([mattermostAccount.instance,mattermostAccount.botUserId,'owner-user']);
const mattermostThread=JSON.stringify(['private-dm','']);
const effectIdFor = (effect, payload) => 'delivery-' + sha(JSON.stringify([
  'artifact-pin-v1', effect.run_id, effect.message_id, effect.destination,
  effect.recipient, effect.artifact_ref, sha(canonicalJson(payload)),
])).slice(0, 32);

function fixture(t, prefix = 'ga-pinned-delivery-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openProductDatabase(':memory:');
  db.exec(`CREATE TABLE wb_persistent_tasks(task_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,status TEXT NOT NULL,
    generation INTEGER NOT NULL,version INTEGER NOT NULL,projection_pending INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE wb_agents(agent_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,status TEXT NOT NULL,capability_epoch INTEGER NOT NULL);
    CREATE TABLE wb_task_finalizations(occurrence_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,run_id TEXT NOT NULL,message_id TEXT NOT NULL);`);
  const bindings=new OwnerChannelBindings(db,{enabled:['wecom','mattermost'],mattermost:mattermostAccount});
  installChannelAuthorityMigration(db);
  const artifacts = new ArtifactService(db, join(root, 'artifacts'));
  const delivery = new ChannelDeliveryService(db, () => 1000);
  const notifications = new TaskNotifications(db);
  db.prepare('INSERT INTO ga_owner_channel_bindings VALUES(?,?,?,?,?,1,?,NULL,?)')
    .run('binding-a', 'owner-a', 'wecom', 'provider-user', 'verified', 1000, 1000);
  const mattermostChallenge=bindings.create('owner-a','mattermost');
  bindings.acceptMattermost({principal:mattermostPrincipal,thread_id:mattermostThread,message_id:'mattermost-bind-post',text:'/jot-bind '+mattermostChallenge.code});
  const mattermostBinding=bindings.resolve('owner-a',mattermostChallenge.channel_binding_id);
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('conv-a', 'owner-a', 'ws', 'title', '{}', 1, 'now', 'now');
  db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('message-a', 'conv-a', 'run-a', 'user', 'complete', JSON.stringify({ blocks: [], attachments: [] }), 'client-a', 'now', 'now');
  db.prepare('INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('run-a', 'conv-a', 'message-a', 'queued', 1, 'now', 'now');
  db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('message-final', 'conv-a', 'run-a', 'assistant', 'complete', JSON.stringify({blocks:[{block_id:'message-final:0',kind:'text',text:'Reviewed final'}],attachments:[]}), null, 'now', 'now');
  db.prepare("INSERT INTO wb_persistent_tasks VALUES(?,?,'active',1,1,0,'now')").run('task-a','owner-a');
  db.prepare("INSERT INTO wb_agents VALUES(?,?,'active',1)").run('agent-a','owner-a');
  db.prepare('INSERT INTO wb_task_finalizations VALUES(?,?,?,?)').run('occurrence-a','owner-a','run-a','message-final');
  db.prepare(`INSERT INTO wb_task_notification_settings(task_id,owner_id,version,bindings_json,created_at,updated_at,delivery_policy_json,events_json)
    VALUES(?,?,?,?,?,?,?,?)`).run('task-a','owner-a',1,JSON.stringify([{channel_binding_id:'binding-a',version:1,artifact_delivery:true},{channel_binding_id:mattermostBinding.channel_binding_id,version:1,artifact_delivery:true}]),'now','now',
    JSON.stringify({min_interval_seconds:60,max_per_24_hours:20,quiet_hours:null}),JSON.stringify(['completed']));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, root, artifacts, delivery, notifications, messageId:'message-final',mattermostAccount,mattermostBinding };
}

function registerTaskOutput(f, { artifactId = 'artifact-file', version = 1, bytes = Buffer.from('pinned bytes'), name = 'report.txt' } = {}) {
  const path = join(f.root, artifactId + '-v' + version + '.txt');
  writeFileSync(path, bytes);
  const digest = sha(bytes);
  const now = 'now';
  f.db.prepare('INSERT INTO ga_artifacts(id,conversation_id,owner_id,kind,current_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(artifactId, 'conv-a', 'owner-a', 'task_output_file', version, now, now);
  f.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(artifactId, version, path, digest, bytes.length, 'text/plain', JSON.stringify({
      file_name: name, status: 'ready', origin: 'generated', task_file: { run_id: 'run-a', receipt_id: 'receipt-a', sha256: digest },
    }), now);
  f.db.prepare('INSERT INTO ga_artifact_archives(artifact_id,backup_status,local_state,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(artifactId, 'pending', 'present', now, now, now);
  f.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)')
    .run('run-a', artifactId, version, now);
  return { artifactId, path, bytes, digest, name };
}

function authorizeTaskArtifact(f,effect,{grant=true}={}){
  const principal=effect.destination==='mattermost'?mattermostPrincipal:'provider-user';
  withImmediateTransaction(f.db,()=>{
    f.delivery.bindTaskAuthorization(effect.effect_id,{owner_id:'owner-a',task_id:'task-a',occurrence_id:'occurrence-a',generation:1,task_version:1,agent_id:'agent-a',epoch:1},'conv-a',principal);
    if(grant)f.notifications.grant(effect.effect_id,'owner-a','task-a',effect.destination==='mattermost'
      ?{channel_binding_id:f.mattermostBinding.channel_binding_id,channel:'mattermost',principal,version:1,settings_version:1,artifact_delivery:true}
      :{channel_binding_id:'binding-a',channel:'wecom',principal,version:1,settings_version:1,artifact_delivery:true});
  });
}

function enqueuePinned(f, artifactId, version = 1, destination = 'wecom', {grant=true,attach=true} = {}) {
  if(attach){
    const row=f.db.prepare('SELECT content_json FROM ga_messages WHERE id=?').get(f.messageId),content=JSON.parse(row.content_json);
    if(!content.attachments.includes(artifactId))content.attachments.push(artifactId);
    f.db.prepare('UPDATE ga_messages SET content_json=? WHERE id=?').run(JSON.stringify(content),f.messageId);
  }
  const recipient=destination==='mattermost'?mattermostPrincipal:'provider-user';
  const effect=f.delivery.enqueuePinnedArtifact({ runId: 'run-a', messageId: f.messageId, destination,
    recipient, ownerId: 'owner-a', artifactId, version }, f.artifacts);
  authorizeTaskArtifact(f,effect,{grant});
  return effect;
}

function workerFor(f, provider, extra = {}, runtime = {}) {
  return new ChannelDeliveryWorker(f.delivery, provider, {
    registerDeliveryReceipt: async () => ({ ok: true }),
    ...runtime,
  }, {
    artifacts: f.artifacts,
    resolveArtifact: () => { throw new Error('legacy_single_resolver_must_not_run'); },
    resolveArtifacts: () => { throw new Error('legacy_group_resolver_must_not_run'); },
    cleanupArtifact: pin => f.artifacts.markPinnedDeliveredAndDelete(pin.run_id, pin),
    resolveRuntime: clientRunId => ({ runtimeRunId: 'runtime-' + clientRunId, clientRunId }),
    ...extra,
  });
}

test('pinned task output is claimed with a generation marker and sent from its fixed version', async t => {
  const f = fixture(t);
  const v1 = registerTaskOutput(f, { bytes: Buffer.from('original reviewed bytes'), name: 'reviewed.txt' });
  const enqueued = enqueuePinned(f, v1.artifactId);
  const effectId = enqueued.effect_id;
  const pinned = JSON.parse(enqueued.payload_json);
  assert.equal(pinned.version, 1);
  assert.deepEqual(Object.keys(pinned).sort(), ['artifact_id', 'conversation_id', 'kind', 'manifest',
    'manifest_sha256', 'owner_id', 'schema_version', 'sha256', 'size_bytes', 'version'].sort());
  assert.equal(enqueued.effect_id, effectIdFor({ run_id: 'run-a', message_id: f.messageId,
    destination: 'wecom', recipient: 'provider-user', artifact_ref: v1.artifactId }, pinned));
  const v2Bytes = Buffer.from('replacement current bytes');
  const v2Path = join(f.root, 'artifact-file-v2.txt');
  writeFileSync(v2Path, v2Bytes);
  f.db.prepare('INSERT INTO ga_artifact_versions(artifact_id,version,server_path,sha256,size_bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('artifact-file', 2, v2Path, sha(v2Bytes), v2Bytes.length, 'text/plain', JSON.stringify({
      file_name: 'replacement.txt', status: 'ready', origin: 'generated', task_file: { run_id: 'run-a', receipt_id: 'receipt-a-v2', sha256: sha(v2Bytes) },
    }), 'now');
  f.db.exec('DROP TRIGGER ga_task_output_no_identity_update');
  f.db.prepare('UPDATE ga_artifacts SET current_version=2 WHERE id=?').run('artifact-file');
  const sentPaths = [];
  const worker = workerFor(f, { sendFile: async (path, recipient, displayName) => {
    sentPaths.push(path);
    assert.equal(recipient, 'provider-user');
    assert.equal(displayName, 'reviewed.txt');
    assert.deepEqual(readFileSync(path), v1.bytes);
    assert.notEqual(path, v1.path);
    const claim = f.db.prepare('SELECT status,generation,file_claim_protocol_generation FROM ga_channel_deliveries WHERE effect_id=?').get(effectId);
    assert.equal(claim.status, 'sending');
    assert.equal(claim.file_claim_protocol_generation, claim.generation);
    return { provider_message_id: 'provider-file-1' };
  } });
  assert.equal(await worker.processNext(), true);
  assert.equal(f.delivery.get(effectId).status, 'delivered');
  const versionStatuses = f.db.prepare(`SELECT version,json_extract(metadata_json,'$.status') AS status
    FROM ga_artifact_versions WHERE artifact_id=? ORDER BY version`).all(v1.artifactId);
  assert.deepEqual(versionStatuses.map(row => [row.version, row.status]), [[1, 'delivered'], [2, 'ready']]);
  assert.deepEqual(f.artifacts.download(v1.artifactId, 'owner-a', 1).verified_content, v1.bytes);
  assert.equal(sentPaths.length, 1);
  assert.equal(existsSync(sentPaths[0]), false);
});

test('generated group sends each exact manifest part as verified bytes in order', async t => {
  const f = fixture(t, 'ga-pinned-group-');
  const sourceA = join(f.root, 'source-a.txt');
  const sourceB = join(f.root, 'source-b.txt');
  const expected = [Buffer.from('first volume'), Buffer.from('second volume')];
  writeFileSync(sourceA, expected[0]);
  writeFileSync(sourceB, expected[1]);
  const group = f.artifacts.registerGenerated('run-a', 'runtime-group-a', [
    { path: sourceA, display_name: 'first.txt' }, { path: sourceB, display_name: 'second.txt' },
  ]);
  f.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)')
    .run('run-a', group.artifact_ref, 1, 'now');
  const produced = f.artifacts.readProducedGroup('owner-a', 'run-a', group.artifact_ref, 1);
  const manifest = produced.parts.map(({ part_index, display_name, sha256, size_bytes, mime_type }) =>
    ({ part_index, display_name, sha256, size_bytes, mime_type }));
  const enqueued = enqueuePinned(f, group.artifact_ref);
  const effectId = enqueued.effect_id;
  const payload = JSON.parse(enqueued.payload_json);
  assert.deepEqual(payload.manifest, manifest);
  const sent = [];
  const worker = workerFor(f, { sendFile: async (path, recipient, displayName) => {
    sent.push({ bytes: readFileSync(path), recipient, displayName, path });
    return { provider_message_id: 'provider-part-' + sent.length };
  } });
  assert.equal(await worker.processNext(), true);
  assert.equal(f.delivery.get(effectId).status, 'delivered');
  assert.deepEqual(sent.map(item => item.bytes), expected);
  assert.deepEqual(sent.map(item => item.displayName), manifest.map(part => part.display_name));
  assert.deepEqual(JSON.parse(f.delivery.get(effectId).provider_receipt_json).receipts,
    [{ part_index: 1, provider_message_id: 'provider-part-1' },
      { part_index: 2, provider_message_id: 'provider-part-2' }]);
  const partStatuses = f.db.prepare(`SELECT json_extract(metadata_json,'$.status') AS status
    FROM ga_artifact_parts WHERE artifact_id=? ORDER BY part_index`).all(group.artifact_ref);
  assert.deepEqual(partStatuses.map(row => row.status), ['delivered', 'delivered']);
  assert.ok(sent.every(item => !existsSync(item.path)));
});

test('an ambiguous later group part retains earlier part receipts and never resends', async t => {
  const f = fixture(t, 'ga-pinned-group-unknown-');
  const sourceA = join(f.root, 'source-a.txt');
  const sourceB = join(f.root, 'source-b.txt');
  writeFileSync(sourceA, Buffer.from('first volume'));
  writeFileSync(sourceB, Buffer.from('second volume'));
  const group = f.artifacts.registerGenerated('run-a', 'runtime-group-unknown', [
    { path: sourceA, display_name: 'first.txt' }, { path: sourceB, display_name: 'second.txt' },
  ]);
  f.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)')
    .run('run-a', group.artifact_ref, 1, 'now');
  const effectId = enqueuePinned(f, group.artifact_ref).effect_id;
  let sends = 0;
  const worker = workerFor(f, { sendFile: async () => {
    sends += 1;
    if (sends === 2) throw new Error('network timeout');
    return { provider_message_id: 'provider-part-1' };
  } });
  assert.equal(await worker.processNext(), true);
  const state = f.delivery.get(effectId);
  assert.equal(state.status, 'outcome_unknown');
  assert.deepEqual(JSON.parse(state.provider_receipt_json), { total: 2,
    receipts: [{ part_index: 1, provider_message_id: 'provider-part-1' }] });
  assert.equal(await worker.processNext(), false);
  assert.equal(sends, 2);
});

test('Mattermost definite rejection on a later group part preserves earlier receipt as unknown',async t=>{
 const f=fixture(t,'ga-pinned-mattermost-partial-'),sourceA=join(f.root,'mattermost-a.txt'),sourceB=join(f.root,'mattermost-b.txt');
 writeFileSync(sourceA,'first Mattermost part');writeFileSync(sourceB,'second Mattermost part');
 const group=f.artifacts.registerGenerated('run-a','mattermost-partial-group',[{path:sourceA,display_name:'first.txt'},{path:sourceB,display_name:'second.txt'}]);
 f.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)').run('run-a',group.artifact_ref,1,'now');
 const effectId=enqueuePinned(f,group.artifact_ref,1,'mattermost').effect_id;let sends=0,runtimeCalls=0,cleanups=0;
 const worker=workerFor(f,{providers:{mattermost:{sendFile:async()=>{sends++;if(sends===2)throw new Error('mattermost_provider_rejected');return{provider_message_id:'mattermost-first-part'};}}}},{mattermostAccount:f.mattermostAccount,cleanupArtifact:()=>{cleanups++;}},{registerDeliveryReceipt:async()=>{runtimeCalls++;return{ok:true};}});
 assert.equal(await worker.processNext(),true);const partial=f.delivery.get(effectId);assert.equal(partial.status,'outcome_unknown');
 assert.deepEqual(JSON.parse(partial.provider_receipt_json),{total:2,receipts:[{part_index:1,provider_message_id:'mattermost-first-part'}]});
 assert.equal(await worker.processNext(),false);assert.equal(sends,2);assert.equal(runtimeCalls,0);assert.equal(cleanups,0);
});

test('revocation after one confirmed group part stops remaining sends and never enters receipt-only success',async t=>{
 const f=fixture(t,'ga-pinned-partial-revoke-'),sourceA=join(f.root,'partial-a.txt'),sourceB=join(f.root,'partial-b.txt');
 writeFileSync(sourceA,'first part');writeFileSync(sourceB,'second part');
 const group=f.artifacts.registerGenerated('run-a','runtime-partial-revoke',[{path:sourceA,display_name:'first.txt'},{path:sourceB,display_name:'second.txt'}]);
 f.db.prepare('INSERT INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)').run('run-a',group.artifact_ref,1,'now');
 const effectId=enqueuePinned(f,group.artifact_ref).effect_id;let sends=0,runtimeCalls=0,cleanups=0;
 const worker=workerFor(f,{sendFile:async()=>{sends++;f.db.prepare("UPDATE ga_owner_channel_bindings SET status='revoked',version=version+1 WHERE channel_binding_id='binding-a'").run();return{provider_message_id:'confirmed-first-part'};}},{cleanupArtifact:()=>{cleanups++;}},{registerDeliveryReceipt:async()=>{runtimeCalls++;return{ok:true};}});
 await assert.rejects(()=>worker.processNext(),/channel_authority_binding_missing/);const partial=f.delivery.get(effectId);assert.equal(partial.status,'sending');assert.deepEqual(JSON.parse(partial.provider_receipt_json),{total:2,receipts:[{part_index:1,provider_message_id:'confirmed-first-part'}]});
 f.db.prepare('UPDATE ga_channel_deliveries SET lease_expires_at=999 WHERE effect_id=?').run(effectId);
 assert.equal(await worker.processNext(),false);const state=f.delivery.get(effectId);assert.equal(state.status,'outcome_unknown');assert.equal(state.provider_receipt_json,partial.provider_receipt_json);assert.equal(sends,1);assert.equal(runtimeCalls,0);assert.equal(cleanups,0);
});

for (const [label, rejectReceipt] of [
  ['runtime rejection', async () => ({ ok: false })],
  ['runtime disconnect', async () => { throw new Error('runtime unavailable'); }],
]) {
  test('pinned file ' + label + ' keeps the accepted provider receipt without cleanup or resend', async t => {
    const f = fixture(t, 'ga-pinned-runtime-receipt-');
    const file = registerTaskOutput(f);
    const effectId = enqueuePinned(f, file.artifactId).effect_id;
    let sends = 0;
    let runtimeCalls = 0;
    let cleanups = 0;
    const worker = workerFor(f, { sendFile: async () => {
      sends += 1;
      return { provider_message_id: 'provider-confirmed-once' };
    } }, { cleanupArtifact: pin => {
      cleanups += 1;
      return f.artifacts.markPinnedDeliveredAndDelete(pin.run_id, pin);
    } }, { registerDeliveryReceipt: async (runtimeRunId, clientRunId, receiptRef, recipient, status) => {
      runtimeCalls += 1;
      assert.equal(receiptRef, 'wecom:group:' + sha('provider-confirmed-once').slice(0, 32));
      assert.equal(recipient, 'provider-user');
      assert.equal(status, 'delivered');
      if (runtimeCalls === 1) return rejectReceipt();
      return { ok: true };
    } });
    assert.equal(await worker.processNext(), true);
    assert.equal(f.delivery.get(effectId).status, 'receipt_pending');
    assert.equal(f.artifacts.get(file.artifactId, 'owner-a', 1).status, 'ready');
    assert.equal(cleanups, 0);
    assert.equal(await worker.processNext(), true);
    assert.equal(f.delivery.get(effectId).status, 'delivered');
    assert.equal(sends, 1);
    assert.equal(runtimeCalls, 2);
    assert.equal(cleanups, 1);
  });
}

test('pinned cleanup failure retries the receipt and scoped cleanup without resending', async t => {
  const f = fixture(t, 'ga-pinned-cleanup-retry-');
  const file = registerTaskOutput(f);
  const effectId = enqueuePinned(f, file.artifactId).effect_id;
  let sends = 0;
  let cleanups = 0;
  const worker = workerFor(f, { sendFile: async () => {
    sends += 1;
    return { provider_message_id: 'provider-confirmed-once' };
  } }, {
    cleanupArtifact: pin => {
      cleanups += 1;
      if (cleanups === 1) throw new Error('artifact_cleanup_temporarily_unavailable');
      return f.artifacts.markPinnedDeliveredAndDelete(pin.run_id, pin);
    },
  });
  assert.equal(await worker.processNext(), true);
  assert.equal(f.delivery.get(effectId).status, 'receipt_pending');
  assert.equal(f.artifacts.get(file.artifactId, 'owner-a', 1).status, 'ready');
  assert.equal(await worker.processNext(), true);
  assert.equal(f.delivery.get(effectId).status, 'delivered');
  assert.equal(sends, 1);
  assert.equal(cleanups, 2);
});

test('legacy unpinned file rows stay pending behind the existing claim fence', async t => {
  const f = fixture(t, 'ga-pinned-legacy-');
  const queued = f.delivery.enqueueProjected({ request_id: 'delivery:legacy-file', run_id: 'a'.repeat(32),
    client_run_id: 'run-a', artifact_ref: 'artifact-legacy', recipient_ref: 'provider-user' });
  let sends = 0;
  const worker = workerFor(f, { sendFile: async () => { sends += 1; return { provider_message_id: 'bad' }; } });
  assert.equal(await worker.processNext(), false);
  assert.equal(f.delivery.get(queued.effect_id).status, 'pending');
  assert.equal(sends, 0);
  assert.throws(() => f.db.prepare(`UPDATE ga_channel_deliveries SET status='sending',generation=1,lease_owner='old',lease_expires_at=2000 WHERE effect_id=?`).run(queued.effect_id),
    /channel_file_claim_protocol_required/);
});

test('an expired claim generation cannot preflight a pinned artifact send', t => {
  const f = fixture(t, 'ga-pinned-generation-');
  const file = registerTaskOutput(f);
  const effectId = enqueuePinned(f, file.artifactId).effect_id;
  const claim = f.delivery.claim('worker-a', 90, ['wecom'], f.artifacts);
  assert.equal(claim.effect_id, effectId);
  assert.throws(() => f.delivery.authorizePinnedArtifactSend(effectId, claim.generation - 1, f.artifacts),
    /delivery_lease_lost/);
  assert.equal(f.delivery.get(effectId).status, 'sending');
});

test('revoked binding is rechecked immediately before the pinned provider call', async t => {
  const f = fixture(t, 'ga-pinned-revoke-');
  const file = registerTaskOutput(f);
  const effectId = enqueuePinned(f, file.artifactId).effect_id;
  const originalClaim = f.delivery.claim.bind(f.delivery);
  f.delivery.claim = (...args) => {
    const claim = originalClaim(...args);
    if (claim?.effect_id === effectId) f.db.prepare("UPDATE ga_owner_channel_bindings SET status='revoked' WHERE channel_binding_id='binding-a'").run();
    return claim;
  };
  let sends = 0;
  const worker = workerFor(f, { sendFile: async () => { sends += 1; return { provider_message_id: 'must-not-send' }; } });
  await assert.rejects(worker.processNext(), /channel_authority_binding_missing/);
  assert.equal(sends, 0);
  assert.equal(f.delivery.get(effectId).status, 'sending');
});

test('Weixin file effects are never eligible for the artifact delivery worker', t => {
  const f = fixture(t, 'ga-pinned-weixin-');
  const file = registerTaskOutput(f);
  assert.throws(() => enqueuePinned(f, file.artifactId, 1, 'weixin'), /channel_delivery_artifact_unsupported/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM ga_channel_deliveries WHERE destination='weixin'").get().n, 0);
});

test('an ungranted direct helper artifact row is not claimable', t => {
  const f=fixture(t,'ga-pinned-ungranted-');
  const file=registerTaskOutput(f),effect=enqueuePinned(f,file.artifactId,1,'wecom',{grant:false});
  const claimed=f.delivery.claim('worker-no-grant',90,['wecom'],f.artifacts);
  assert.equal(claimed,null);
  assert.equal(f.delivery.get(effect.effect_id).status,'cancelled');
});

test('pinned source must be an attachment of the exact final assistant message', t => {
  const f=fixture(t,'ga-pinned-attachment-membership-');
  const file=registerTaskOutput(f);
  assert.throws(()=>enqueuePinned(f,file.artifactId,1,'wecom',{grant:false,attach:false}),/channel_delivery_attachment_membership_mismatch/);
});

for(const destination of ['email','webpush'])test(`file route rejects unsupported ${destination} before creating a delivery receipt`, t => {
  const f=fixture(t,`ga-pinned-unsupported-${destination}-`),file=registerTaskOutput(f);
  assert.throws(()=>enqueuePinned(f,file.artifactId,1,destination),/channel_delivery_artifact_unsupported/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);
});

for (const [label, result] of [
  ['timeout', async () => { throw new Error('network timeout'); }],
  ['missing stable ID', async () => ({ provider_message_id: '   ' })],
  ['missing provider response', async () => null],
]) {
  test('pinned file ' + label + ' becomes unknown and is never resent', async t => {
    const f = fixture(t, 'ga-pinned-unknown-');
    const file = registerTaskOutput(f);
    const effectId = enqueuePinned(f, file.artifactId).effect_id;
    let sends = 0;
    const worker = workerFor(f, { sendFile: async () => { sends += 1; return result(); } });
    assert.equal(await worker.processNext(), true);
    assert.equal(f.delivery.get(effectId).status, 'outcome_unknown');
    assert.equal(await worker.processNext(), false);
    assert.equal(sends, 1);
  });
}
