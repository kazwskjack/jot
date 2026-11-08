import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openProductDatabase } from '../../src/db/database.ts';
import { ChannelDeliveryService } from '../../src/channels/delivery.ts';
import { ChannelDeliveryWorker } from '../../src/channels/worker.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { installChannelAuthorityMigration } from '../../src/channels/authority-migration.ts';

function fixture(prefix = 'ga-delivery-worker-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const db = openProductDatabase(join(directory, 'db.sqlite'));
  new OwnerChannelBindings(db, { enabled: ['wecom'] });
  installChannelAuthorityMigration(db);
  db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('conv', 'owner', 'ws', 't', '{}', 1, 'now', 'now');
  db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('input', 'conv', null, 'user', 'complete', '{"blocks":[]}', 'now', 'now');
  db.prepare("INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run('run-1', 'conv', 'input', 'running', 1, 'now', 'now');
  return { db, directory };
}

test('delivery worker leaves projected legacy artifacts pending without resolving their paths', async () => {
  const { db, directory } = fixture();
  const store = new ChannelDeliveryService(db);
  store.enqueueProjected({ request_id: 'delivery:abc', run_id: 'a'.repeat(32),
    client_run_id: 'run-1', artifact_ref: 'artifact:report-1', recipient_ref: 'owner' });
  let sends = 0; let resolutions = 0;
  const worker = new ChannelDeliveryWorker(store, {
    sendFile: async () => { sends += 1; return { provider_message_id: 'wx-1' }; },
  }, { registerDeliveryReceipt: async () => ({ ok: true }) }, {
    resolveArtifact: () => { resolutions += 1; return { path: '/unsafe/report.docx', displayName: 'report.docx' }; },
    resolveArtifacts: () => { resolutions += 1; return [{ path: '/unsafe/report.docx', displayName: 'report.docx' }]; },
    resolveRuntime: () => ({ runtimeRunId: 'a'.repeat(32), clientRunId: 'run-1' }),
  });
  try {
    assert.equal(await worker.processNext(), false);
    assert.equal(store.get('delivery:abc').status, 'pending');
    assert.equal(sends, 0);
    assert.equal(resolutions, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('delivery worker sends a text delivery without resolving an artifact or Runtime binding', async () => {
  const { db, directory } = fixture('ga-delivery-worker-text-');
  const store = new ChannelDeliveryService(db);
  store.enqueueExternal({ runId: 'run-1', messageId: 'msg-text-1', destination: 'wecom',
    recipient: 'owner', artifactRef: null, text: '需要登录：请打开登录链接。' });
  const calls = [];
  const worker = new ChannelDeliveryWorker(store, {
    sendFile: async () => { throw new Error('artifact_path_must_not_be_resolved'); },
    send: async (...args) => { calls.push(['send', ...args]); return { ok: true, errcode: 0 }; },
  }, { registerDeliveryReceipt: async () => { throw new Error('runtime_receipt_not_required_for_chat_text'); } }, {
    resolveArtifact: () => { throw new Error('artifact_must_not_be_resolved'); },
    resolveRuntime: () => { throw new Error('runtime_binding_must_not_be_required'); },
  });
  try {
    assert.equal(await worker.processNext(), true);
    const row = db.prepare('SELECT status,effect_id,generation FROM ga_channel_deliveries').get();
    assert.deepEqual(calls, [['send', '需要登录：请打开登录链接。', 'owner', {
      effectId: row.effect_id, generation: row.generation, idempotencyKey: row.effect_id,
    }]]);
    assert.equal(row.status, 'delivered');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('webpush acceptance records a local outbox receipt exactly once', async () => {
  const { db, directory } = fixture('ga-delivery-worker-webpush-');
  const store = new ChannelDeliveryService(db);
  const queued = store.enqueueExternal({ runId: 'run-1', messageId: 'push-event-1', destination: 'webpush',
    recipient: 'push-binding-opaque', artifactRef: null, text: '任务已经完成。' });
  let sends = 0;
  const worker = new ChannelDeliveryWorker(store, { providers: { webpush: {
    send: async () => { sends += 1; return { accepted: true, status: 201 }; },
    sendFile: async () => ({ accepted: false, code: 'PUSH_FILE_DELIVERY_UNSUPPORTED' }),
  } } }, { registerDeliveryReceipt: async () => { throw new Error('text_push_has_no_runtime_receipt'); } }, {
    resolveArtifact: () => { throw new Error('text_push_must_not_resolve_artifact'); },
    resolveRuntime: () => { throw new Error('text_push_must_not_resolve_runtime'); },
  });
  try {
    assert.equal(await worker.processNext(), true);
    assert.equal(store.get(queued.effect_id).status, 'delivered');
    assert.match(store.get(queued.effect_id).provider_receipt_json, /webpush-accepted/);
    assert.equal(await worker.processNext(), false);
    assert.equal(sends, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('definitively rejected or expired webpush effects are cancelled and never resent', async () => {
  const { db, directory } = fixture('ga-delivery-worker-webpush-rejected-');
  const store = new ChannelDeliveryService(db);
  const queued = store.enqueueExternal({ runId: 'run-1', messageId: 'push-event-2', destination: 'webpush',
    recipient: 'push-binding-opaque', artifactRef: null, text: '任务已经失败。' });
  let sends = 0;
  const worker = new ChannelDeliveryWorker(store, { providers: { webpush: {
    send: async () => { sends += 1; return { accepted: false, code: 'PUSH_SUBSCRIPTION_EXPIRED' }; },
    sendFile: async () => ({ accepted: false, code: 'PUSH_FILE_DELIVERY_UNSUPPORTED' }),
  } } }, { registerDeliveryReceipt: async () => ({ ok: true }) }, {
    resolveArtifact: () => ({ path: '', displayName: '' }), resolveRuntime: () => ({ runtimeRunId: '', clientRunId: '' }),
  });
  try {
    assert.equal(await worker.processNext(), true);
    assert.equal(store.get(queued.effect_id).status, 'cancelled');
    assert.equal(store.get(queued.effect_id).last_reason_code, 'PUSH_SUBSCRIPTION_EXPIRED');
    assert.equal(await worker.processNext(), false);
    assert.equal(sends, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('ambiguous webpush transport failure is marked unknown and never blindly retried', async () => {
  const { db, directory } = fixture('ga-delivery-worker-webpush-unknown-');
  const store = new ChannelDeliveryService(db);
  const queued = store.enqueueExternal({ runId: 'run-1', messageId: 'push-event-3', destination: 'webpush',
    recipient: 'push-binding-opaque', artifactRef: null, text: '需要你确认。' });
  let sends = 0;
  const worker = new ChannelDeliveryWorker(store, { providers: { webpush: {
    send: async () => { sends += 1; throw new Error('push_provider_network_error'); },
    sendFile: async () => ({ accepted: false, code: 'PUSH_FILE_DELIVERY_UNSUPPORTED' }),
  } } }, { registerDeliveryReceipt: async () => ({ ok: true }) }, {
    resolveArtifact: () => ({ path: '', displayName: '' }), resolveRuntime: () => ({ runtimeRunId: '', clientRunId: '' }),
  });
  try {
    assert.equal(await worker.processNext(), true);
    assert.equal(store.get(queued.effect_id).status, 'outcome_unknown');
    assert.equal(await worker.processNext(), false);
    assert.equal(sends, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('webpush 429 retries on bounded backoff and stops after three attempts',async()=>{
 const {db,directory}=fixture('ga-delivery-worker-webpush-retry-');let now=1_700_000_000;
 const store=new ChannelDeliveryService(db,()=>now),queued=store.enqueueExternal({runId:'run-1',messageId:'push-event-retry',destination:'webpush',recipient:'push-binding-opaque',artifactRef:null,text:'任务提醒。'});
 db.prepare('UPDATE ga_channel_deliveries SET generation=5 WHERE effect_id=?').run(queued.effect_id);
 let sends=0;
 const worker=new ChannelDeliveryWorker(store,{providers:{webpush:{send:async()=>{sends++;return {accepted:false,retryable:true,status:429,code:'PUSH_PROVIDER_RATE_LIMITED'};},sendFile:async()=>({accepted:false,code:'PUSH_FILE_DELIVERY_UNSUPPORTED'})}}},{registerDeliveryReceipt:async()=>({ok:true})},{resolveArtifact:()=>({path:'',displayName:''}),resolveRuntime:()=>({runtimeRunId:'',clientRunId:''})});
 try{
  await worker.processNext();assert.equal(store.get(queued.effect_id).status,'pending');assert.equal(store.get(queued.effect_id).last_reason_code,'PUSH_PROVIDER_RATE_LIMITED');
  assert.equal(db.prepare('SELECT not_before FROM wb_task_notification_deferrals WHERE effect_id=?').get(queued.effect_id).not_before,now+30);
  assert.equal(await worker.processNext(),false);now+=30;await worker.processNext();assert.equal(sends,2);
  assert.equal(db.prepare('SELECT not_before FROM wb_task_notification_deferrals WHERE effect_id=?').get(queued.effect_id).not_before,now+60);
  now+=60;await worker.processNext();assert.equal(sends,3);assert.equal(store.get(queued.effect_id).status,'cancelled');
  assert.equal(store.get(queued.effect_id).last_reason_code,'PUSH_PROVIDER_RETRY_EXHAUSTED');assert.equal(await worker.processNext(),false);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

test('webpush 5xx is outcome unknown and is never retried or reported cancelled',async()=>{
 const {db,directory}=fixture('ga-delivery-worker-webpush-5xx-'),store=new ChannelDeliveryService(db);
 const queued=store.enqueueExternal({runId:'run-1',messageId:'push-event-5xx',destination:'webpush',recipient:'push-binding-opaque',artifactRef:null,text:'任务提醒。'});let sends=0;
 const worker=new ChannelDeliveryWorker(store,{providers:{webpush:{send:async()=>{sends++;return {accepted:false,outcome_unknown:true,status:503,code:'PUSH_PROVIDER_OUTCOME_UNKNOWN'};},sendFile:async()=>({accepted:false,code:'PUSH_FILE_DELIVERY_UNSUPPORTED'})}}},{registerDeliveryReceipt:async()=>({ok:true})},{resolveArtifact:()=>({path:'',displayName:''}),resolveRuntime:()=>({runtimeRunId:'',clientRunId:''})});
 try{await worker.processNext();assert.equal(store.get(queued.effect_id).status,'outcome_unknown');assert.notEqual(store.get(queued.effect_id).status,'cancelled');assert.equal(await worker.processNext(),false);assert.equal(sends,1);}
 finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
