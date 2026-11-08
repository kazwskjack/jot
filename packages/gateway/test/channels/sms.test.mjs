import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createTwilioSmsDeliveryProvider,
  createTwilioSmsWebhookAdapter,
  resolveTwilioSmsReplyContext,
  validateTwilioRequestSignature,
} from '../../src/channels/sms.ts';
import { ChannelIntakeService } from '../../src/channels/intake.ts';
import { openProductDatabase } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { installChannelAuthorityMigration } from '../../src/channels/authority-migration.ts';
import { ChannelDeliveryService } from '../../src/channels/delivery.ts';
import { ChannelDeliveryWorker } from '../../src/channels/worker.ts';
import { buildServer } from '../../src/server.ts';

const accountSid = ('AC' + '0'.repeat(30) + '01');
const apiKeySid = ('SK' + '0'.repeat(30) + '03');
const apiKeySecret = 'twilio-api-key-secret-fixture';
const authToken = 'twilio-auth-token-fixture';
const webhookUrl = 'https://jot.example.test/hooks/v1/channels/sms?route=primary';
const from = '+14155550123';
const to = '+14155550999';
const messageSid = 'SM0123456789abcdef0123456789abcdef';

function twilioSignature(token, url, params) {
  const suffix = Object.keys(params).sort().map(key => {
    const value = params[key];
    if (Array.isArray(value)) return [...new Set(value)].sort().map(item => key + item).join('');
    return key + value;
  }).join('');
  return createHmac('sha1', token).update(url + suffix).digest('base64');
}

function webhookParams(overrides = {}) {
  return {
    AccountSid: accountSid,
    From: from,
    To: to,
    Body: 'hello from SMS',
    MessageSid: messageSid,
    NumMedia: '1',
    MediaContentType0: 'image/jpeg',
    MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/' + accountSid
      + '/Messages/' + messageSid + '/Media/ME0123456789abcdef0123456789abcdef',
    NewTwilioParameter: 'included in the signature',
    ...overrides,
  };
}

function encodeForm(params) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const item of value) form.append(key, item);
    else form.append(key, value);
  }
  return Buffer.from(form.toString());
}

function request(params, overrides = {}) {
  const body = encodeForm(params);
  const signature = twilioSignature(authToken, webhookUrl, params);
  return {
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-twilio-signature': signature,
      ...overrides,
    },
    body,
  };
}

function insertSmsReplyContext(db, effectId, runId, principal) {
  const conversationId=`conversation-${runId}`,inputMessageId=`input-${runId}`;
  const assistantMessageId=`assistant-${runId}`,bindingId=`binding-${runId}`;
  db.exec(`CREATE TABLE ga_channel_deliveries(effect_id TEXT PRIMARY KEY,run_id TEXT,message_id TEXT,destination TEXT,
      recipient TEXT,artifact_ref TEXT,payload_json TEXT,status TEXT,provider_receipt_json TEXT);
    CREATE TABLE ga_channel_message_events(channel TEXT,principal TEXT,provider_thread_id TEXT,provider_message_id TEXT,
      conversation_id TEXT,message_id TEXT,run_id TEXT,channel_binding_id TEXT,binding_version INTEGER);
    CREATE TABLE ga_runs(id TEXT,conversation_id TEXT,input_message_id TEXT);
    CREATE TABLE ga_conversations(id TEXT,owner_id TEXT);
    CREATE TABLE ga_messages(id TEXT,conversation_id TEXT,run_id TEXT,role TEXT);
    CREATE TABLE ga_owner_channel_bindings(channel_binding_id TEXT,owner_id TEXT,channel TEXT,principal TEXT,status TEXT,version INTEGER);
    CREATE TABLE ga_channel_threads(channel TEXT,principal TEXT,provider_thread_id TEXT,conversation_id TEXT,channel_binding_id TEXT,binding_version INTEGER);`);
  db.prepare('INSERT INTO ga_conversations VALUES(?,?)').run(conversationId,'alice');
  db.prepare('INSERT INTO ga_runs VALUES(?,?,?)').run(runId,conversationId,inputMessageId);
  db.prepare('INSERT INTO ga_messages VALUES(?,?,?,?)').run(inputMessageId,conversationId,runId,'user');
  db.prepare('INSERT INTO ga_messages VALUES(?,?,?,?)').run(assistantMessageId,conversationId,runId,'assistant');
  db.prepare('INSERT INTO ga_owner_channel_bindings VALUES(?,?,?,?,?,?)')
    .run(bindingId,'alice','sms',principal,'verified',1);
  db.prepare('INSERT INTO ga_channel_threads VALUES(?,?,?,?,?,?)')
    .run('sms',principal,to,conversationId,bindingId,1);
  db.prepare('INSERT INTO ga_channel_message_events VALUES(?,?,?,?,?,?,?,?,?)')
    .run('sms',principal,to,messageSid,conversationId,inputMessageId,runId,bindingId,1);
  db.prepare(`INSERT INTO ga_channel_deliveries VALUES(?,?,?,'sms',?,NULL,?,'sending',NULL)`)
    .run(effectId,runId,assistantMessageId,principal,JSON.stringify({kind:'text',text:'reply text'}));
  return {conversationId,inputMessageId,assistantMessageId,bindingId};
}

function createQueuedSmsReply(effectId, owner='alice') {
  const db=openProductDatabase(':memory:');
  const bindings=new OwnerChannelBindings(db,{enabled:['sms']});
  installChannelAuthorityMigration(db);
  const principal=`sms:${accountSid}:${from}`;
  const challenge=bindings.create(owner,'sms',`sms-review-${randomUUID()}`);
  bindings.acceptProof('sms',principal,challenge.code);
  const runs=new RunRepository(db,new EventStore(db));
  const intake=new ChannelIntakeService(db,runs,'sms-review-workspace',bindings);
  const providerMessageId=`SM${randomUUID().replaceAll('-','')}`;
  const accepted=intake.accept({channel:'sms',principal,thread_id:to,message_id:providerMessageId,text:'source SMS'});
  const event=db.prepare('SELECT * FROM ga_channel_message_events WHERE channel=? AND principal=? AND provider_thread_id=? AND provider_message_id=?')
    .get('sms',principal,to,providerMessageId);
  const assistantMessageId=`assistant-${randomUUID()}`,now=new Date().toISOString();
  db.prepare(`INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at)
    VALUES(?,?,?,'assistant','complete',?,NULL,?,?)`).run(assistantMessageId,event.conversation_id,accepted.run_id,
      JSON.stringify({blocks:[{block_id:assistantMessageId,kind:'text',text:'reply text'}]}),now,now);
  db.prepare(`INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,created_at,updated_at)
    VALUES(?,?,?,'sms',?,NULL,?,'pending',?,?)`).run(effectId,accepted.run_id,assistantMessageId,principal,
      JSON.stringify({kind:'text',text:'reply text'}),now,now);
  return {db,bindings,challenge,principal,accepted,event,assistantMessageId,effectId};
}

function createSmsWorker(db,provider) {
  const store=new ChannelDeliveryService(db);
  const worker=new ChannelDeliveryWorker(store,{providers:{sms:provider}},
    {async registerDeliveryReceipt(){throw new Error('SMS text must not request a Runtime receipt');}},
    {resolveRuntime(){throw new Error('SMS text must not resolve a Runtime');}});
  return {store,worker};
}

test('Twilio signed SMS maps account, phone, message, thread, and media identities through existing intake', async () => {
  const params = webhookParams({ NewTwilioParameter: ['second value', 'first value'] });
  const calls = [];
  const adapter = createTwilioSmsWebhookAdapter({ accountSid, authToken, webhookUrl,
    validateRequest(token, signature, url, receivedParams) {
      calls.push({ token, signature, url, receivedParams });
      return signature === twilioSignature(token, url, receivedParams);
    },
    intake: { accept(input, options) { return { input, options, run_id: 'run-sms-fixture' }; } },
  });
  const result = await adapter.handle(request(params, { host: 'attacker.example' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, authToken);
  assert.equal(calls[0].url, webhookUrl);
  assert.deepEqual(calls[0].receivedParams, params);
  assert.deepEqual(result.intake_result, {
    input: { channel: 'sms', principal: `sms:${accountSid}:${from}`, thread_id: to,
      message_id: messageSid, text: 'hello from SMS', attachments: [{
        provider_file_id: `${messageSid}:media:0`, file_name: 'media-0', media_type: 'image/jpeg',
        media_url: webhookParams().MediaUrl0,
      }] },
    options: { providerSignatureVerified: true },
    run_id: 'run-sms-fixture',
  });
  assert.deepEqual({ status: result.status, contentType: result.contentType, body: result.body }, {
    status: 200, contentType: 'application/xml; charset=utf-8',
    body: '<?xml version="1.0" encoding="UTF-8"?><Response/>',
  });
});

test('Twilio requires a signature and form body before intake and rejects tampered parameters', async () => {
  let intakeCalls = 0;
  const adapter = createTwilioSmsWebhookAdapter({ accountSid, authToken, webhookUrl,
    validateRequest(token, signature, url, params) {
      return signature === twilioSignature(token, url, params);
    },
    intake: { accept() { intakeCalls++; return {}; } },
  });
  const valid = request(webhookParams());
  await assert.rejects(adapter.handle({ ...valid, headers: { ...valid.headers, 'x-twilio-signature': '' } }),
    /sms_signature_invalid/);
  await assert.rejects(adapter.handle({ ...valid, body: Buffer.from(valid.body.toString() + '&Body=forged') }),
    /sms_signature_invalid/);
  await assert.rejects(adapter.handle({ ...valid, headers: { ...valid.headers, 'content-type': 'application/json' } }),
    /sms_content_type_invalid/);
  assert.equal(intakeCalls, 0);
});

test('Twilio callback is account-bound and rejects duplicate identity fields before intake', async () => {
  let intakeCalls = 0;
  const adapter = createTwilioSmsWebhookAdapter({ accountSid, authToken, webhookUrl,
    validateRequest(token, signature, url, params) {
      return signature === twilioSignature(token, url, params);
    },
    intake: { accept() { intakeCalls++; return {}; } },
  });
  await assert.rejects(adapter.handle(request(webhookParams({ AccountSid: ('AC' + '0'.repeat(30) + '02') }))),
    /sms_account_sid_mismatch/);
  const duplicate = Buffer.from(encodeForm(webhookParams()).toString() + `&From=${encodeURIComponent(from)}`);
  const params = webhookParams();
  const signature = twilioSignature(authToken, webhookUrl, params);
  await assert.rejects(adapter.handle({ body: duplicate, headers: {
    'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature,
  } }), /sms_parameter_duplicate/);
  assert.equal(intakeCalls, 0);
});

test('Twilio keeps media-only inbound messages for V2 staging and caps attachment metadata', async () => {
  const accepted = [];
  const adapter = createTwilioSmsWebhookAdapter({ accountSid, authToken, webhookUrl,
    validateRequest(token, signature, url, params) {
      return signature === twilioSignature(token, url, params);
    },
    intake: { accept(input) { accepted.push(input); return {}; } },
  });
  const mediaOnly = webhookParams({ Body: '' });
  assert.equal((await adapter.handle(request(mediaOnly))).intake_result !== undefined, true);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].text, '');
  assert.equal(accepted[0].attachments.length, 1);
  await assert.rejects(adapter.handle(request(webhookParams({ NumMedia: '11' }))), /sms_media_count_invalid/);
  assert.equal(accepted.length, 1);
});

test('standard-library Twilio request validator signs all stable form fields and rejects altered signatures', () => {
  const params = webhookParams({ Extra: ['second','first','first'] });
  const signed = twilioSignature(authToken, webhookUrl, params);
  assert.equal(validateTwilioRequestSignature(authToken, signed, webhookUrl, params), true);
  assert.equal(validateTwilioRequestSignature(authToken, signed, webhookUrl + '/', params), false);
  assert.equal(validateTwilioRequestSignature(authToken, 'A'.repeat(28), webhookUrl, params), false);
});

test('Twilio delivery resolves the inbound sender and number from Jot event/outbox rows and records Message SID', async () => {
  const db = new DatabaseSync(':memory:');
  const principal = `sms:${accountSid}:${from}`;
  insertSmsReplyContext(db,'sms-effect-1','run-1',principal);
  const calls = [];
  const provider = createTwilioSmsDeliveryProvider({ accountSid, apiKeySid, apiKeySecret }, db, async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ sid: 'SMabcdef0123456789abcdef0123456789' }), { status: 201 });
  });
  const receipt = await provider.sendWithKey('reply text', principal, 'sms-effect-1');
  assert.deepEqual(receipt, { provider_message_id: 'SMabcdef0123456789abcdef0123456789' });
  assert.equal(calls[0].url, `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`);
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64')}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), {
    To: from, From: to, Body: 'reply text',
  });
  await assert.rejects(provider.sendWithKey('wrong sender', `sms:${accountSid}:+14155550124`, 'sms-effect-1'),
    /sms_reply_context_missing/);
  assert.equal(calls.length, 1);
  db.close();
});

test('Twilio delivery reports missing receipt for unknown outcome and never invents a SID', async () => {
  const db = new DatabaseSync(':memory:');
  const principal = `sms:${accountSid}:${from}`;
  insertSmsReplyContext(db,'sms-effect-2','run-2',principal);
  const responses = [new Response(JSON.stringify({}), { status: 201 }),
    new Response(JSON.stringify({ sid: 'SM-invalid' }), { status: 201 }),
    new Response(JSON.stringify({ message: 'rejected' }), { status: 400 })];
  const provider = createTwilioSmsDeliveryProvider({ accountSid, apiKeySid, apiKeySecret }, db,
    async () => responses.shift());
  assert.deepEqual(await provider.sendWithKey('reply 1', principal, 'sms-effect-2'), {});
  assert.deepEqual(await provider.sendWithKey('reply 2', principal, 'sms-effect-2'), {});
  assert.deepEqual(await provider.sendWithKey('reply 3', principal, 'sms-effect-2'), {});
  db.close();
});

test('Twilio message SID replay reuses the existing Jot run and conversation before receipt-aware delivery', async () => {
  const service=await buildServer({databasePath:':memory:',workspaces:['workspace-sms'],uploadRoot:'test-tmp/sms-replay-files',workbenchRoot:'test-tmp/sms-replay-workbench'});
  const db = service.db;
  try {
    installChannelAuthorityMigration(db);
    const principal = `sms:${accountSid}:${from}`;
    const bindings = new OwnerChannelBindings(db, {enabled:['sms']});
    const challenge = bindings.create('alice','sms','sms-replay-binding');
    bindings.acceptProof('sms',principal,challenge.code);
    const intake = new ChannelIntakeService(db, new RunRepository(db, new EventStore(db)), 'workspace-sms', bindings);
    const adapter = createTwilioSmsWebhookAdapter({ accountSid, authToken, webhookUrl,
      validateRequest(token, signature, url, params) {
        return signature === twilioSignature(token, url, params);
      }, intake,
    });
    const params = webhookParams({ NumMedia: '0', MediaContentType0: undefined, MediaUrl0: undefined,
      NewTwilioParameter: undefined });
    delete params.MediaContentType0;
    delete params.MediaUrl0;
    delete params.NewTwilioParameter;
    const inbound = request(params);
    const first = await adapter.handle(inbound);
    const replay = await adapter.handle(inbound);
    assert.equal(first.intake_result.accepted, true);
    assert.equal(replay.intake_result.run_id, first.intake_result.run_id);
    assert.equal(replay.intake_result.conversation_id, first.intake_result.conversation_id);
    assert.equal(db.prepare("SELECT count(*) AS n FROM ga_channel_message_events WHERE channel='sms'").get().n, 1);

    const now = new Date().toISOString(),assistantMessageId=`assistant-${randomUUID()}`;
    db.prepare(`INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at)
      VALUES(?,?,?,'assistant','complete',?,NULL,?,?)`).run(assistantMessageId,first.intake_result.conversation_id,
        first.intake_result.run_id,JSON.stringify({blocks:[{block_id:assistantMessageId,kind:'text',text:'reply text'}]}),now,now);
    db.prepare(`INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,artifact_ref,
      payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,'pending',?,?)`).run(
      'sms-effect-end-to-end', first.intake_result.run_id, assistantMessageId, 'sms', principal,
      JSON.stringify({ kind: 'text', text: 'reply text' }), now, now);
    let calls=0;
    const provider = createTwilioSmsDeliveryProvider({ accountSid, apiKeySid, apiKeySecret }, db,
      async () => {calls+=1;return new Response(JSON.stringify({ sid: 'SMabcdef0123456789abcdef0123456789' }), { status: 201 });});
    const store=new ChannelDeliveryService(db),worker=new ChannelDeliveryWorker(store,{providers:{sms:provider}},
      {async registerDeliveryReceipt(){throw new Error('text delivery must not register a runtime receipt');}},
      {resolveRuntime(){throw new Error('text delivery must not resolve a runtime');}});
    assert.equal(await worker.processNext(),true);
    assert.equal(store.get('sms-effect-end-to-end').status,'delivered');
    assert.equal(calls,1);
  } finally { await service.app.close(); db.close(); }
});

test('registered SMS intake recovers a persisted receipt after cold reopen and never replays UNKNOWN', async () => {
  const root=join('test-tmp',`sms-cold-reopen-${randomUUID()}`);
  mkdirSync(root,{recursive:true});
  mkdirSync(join(root,'uploads'),{recursive:true});
  mkdirSync(join(root,'workbench'),{recursive:true});
  const databasePath=join(root,'jot.db'),csrfToken='sms-cold-csrf-fixture-token-123456';
  const config={databasePath,workspaces:['sms-cold-workspace'],csrfToken,
    allowedOrigins:['https://fixture.invalid'],internalChannelToken:'sms-cold-internal-token-123456',
    uploadRoot:join(root,'uploads'),workbenchRoot:join(root,'workbench'),
    smsWebhook:{accountSid,authToken,webhookUrl,apiKeySid,apiKeySecret}};
  let service,db;
  try {
    service=await buildServer(config);
    const binding=await service.app.inject({method:'POST',url:'/v1/channel-bindings',
      headers:{'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':csrfToken,
        'idempotency-key':'sms-cold-binding-key'},payload:{channel:'sms'}});
    assert.equal(binding.statusCode,201,binding.body);
    const proofParams=webhookParams({Body:`/jot-bind ${binding.json().code}`,
      MessageSid:'SM1123456789abcdef0123456789abcdef',NumMedia:'0'});
    delete proofParams.MediaContentType0; delete proofParams.MediaUrl0; delete proofParams.NewTwilioParameter;
    const proof=request(proofParams);
    const proofResponse=await service.app.inject({method:'POST',url:'/hooks/v1/channels/sms',
      headers:proof.headers,payload:proof.body});
    assert.equal(proofResponse.statusCode,200,proofResponse.body);

    const messageParams=webhookParams({Body:'cold reopen hello',NumMedia:'0'});
    delete messageParams.MediaContentType0; delete messageParams.MediaUrl0; delete messageParams.NewTwilioParameter;
    const message=request(messageParams);
    const accepted=await service.app.inject({method:'POST',url:'/hooks/v1/channels/sms',
      headers:message.headers,payload:message.body});
    const replay=await service.app.inject({method:'POST',url:'/hooks/v1/channels/sms',
      headers:message.headers,payload:message.body});
    assert.equal(accepted.statusCode,200,accepted.body);
    assert.equal(replay.statusCode,200,replay.body);
    const principal=`sms:${accountSid}:${from}`;
    const sourceEvent=service.db.prepare("SELECT run_id,conversation_id FROM ga_channel_message_events WHERE channel='sms' AND provider_message_id=?")
      .get(messageSid);
    const runId=sourceEvent.run_id,assistantMessageId=`assistant-${randomUUID()}`,unknownAssistantMessageId=`assistant-${randomUUID()}`;
    const now=new Date().toISOString();
    for(const id of [assistantMessageId,unknownAssistantMessageId])service.db.prepare(`INSERT INTO ga_messages(
      id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at)
      VALUES(?,?,?,'assistant','complete',?,NULL,?,?)`).run(id,sourceEvent.conversation_id,runId,
        JSON.stringify({blocks:[{block_id:id,kind:'text',text:'reply text'}]}),now,now);
    assert.equal(service.db.prepare("SELECT count(*) AS n FROM ga_channel_message_events WHERE channel='sms' AND provider_message_id=?")
      .get(messageSid).n,1);

    const recoveryEffectId='sms-effect-cold-recovery',unknownEffectId='sms-effect-unknown-no-replay';
    const insertEffect=(db,effectId,messageId)=>db.prepare(`INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,
      destination,recipient,artifact_ref,payload_json,status,created_at,updated_at)
      VALUES(?,?,?,'sms',?,NULL,?,'pending',?,?)`).run(effectId,runId,messageId,principal,
        JSON.stringify({kind:'text',text:'reply text'}),new Date().toISOString(),new Date().toISOString());
    insertEffect(service.db,recoveryEffectId,assistantMessageId);
    const store=new ChannelDeliveryService(service.db),claim=store.claim('sms-cold-crash',90,['sms']);
    assert.equal(claim.effect_id,recoveryEffectId);
    let providerCalls=0;
    const syntheticSid='SMabcdef0123456789abcdef0123456789';
    const provider=createTwilioSmsDeliveryProvider({accountSid,apiKeySid,apiKeySecret},service.db,async()=>{
      providerCalls+=1;return new Response(JSON.stringify({sid:syntheticSid}),{status:201});
    });
    const receipt=await provider.sendWithKey('reply text',principal,recoveryEffectId);
    assert.deepEqual(receipt,{provider_message_id:syntheticSid});
    store.recordProviderSent(recoveryEffectId,Number(claim.generation),receipt);
    assert.equal(store.get(recoveryEffectId).status,'receipt_pending');
    assert.equal(providerCalls,1);
    await service.app.close(); service.db.close(); service=null;

    db=openProductDatabase(databasePath);
    const reopenedStore=new ChannelDeliveryService(db);
    let recoveryCalls=0;
    const recoveryProvider=createTwilioSmsDeliveryProvider({accountSid,apiKeySid,apiKeySecret},db,async()=>{
      recoveryCalls+=1;throw new Error('persisted receipt must recover without a provider call');
    });
    const runtime={async registerDeliveryReceipt(){throw new Error('SMS text must not request a Runtime receipt');}};
    const resolvers={resolveRuntime(){throw new Error('SMS text must not resolve a Runtime');}};
    const recoveryWorker=new ChannelDeliveryWorker(reopenedStore,{providers:{sms:recoveryProvider}},runtime,resolvers);
    assert.equal(await recoveryWorker.processNext(),true);
    assert.equal(reopenedStore.get(recoveryEffectId).status,'delivered');
    assert.equal(JSON.parse(reopenedStore.get(recoveryEffectId).provider_receipt_json).provider_message_id,syntheticSid);
    assert.equal(recoveryCalls,0);

    insertEffect(db,unknownEffectId,unknownAssistantMessageId);
    let unknownCalls=0;
    const unknownProvider=createTwilioSmsDeliveryProvider({accountSid,apiKeySid,apiKeySecret},db,async()=>{
      unknownCalls+=1;return new Response('provider outcome unavailable',{status:503});
    });
    const unknownWorker=new ChannelDeliveryWorker(reopenedStore,{providers:{sms:unknownProvider}},runtime,resolvers);
    assert.equal(await unknownWorker.processNext(),true);
    assert.equal(reopenedStore.get(unknownEffectId).status,'outcome_unknown');
    assert.equal(unknownCalls,1);
    db.close(); db=null;

    db=openProductDatabase(databasePath);
    const coldStore=new ChannelDeliveryService(db);
    let replayCalls=0;
    const neverReplayProvider=createTwilioSmsDeliveryProvider({accountSid,apiKeySid,apiKeySecret},db,async()=>{
      replayCalls+=1;throw new Error('UNKNOWN SMS outcome must never replay');
    });
    const coldWorker=new ChannelDeliveryWorker(coldStore,{providers:{sms:neverReplayProvider}},runtime,resolvers);
    assert.equal(coldStore.get(unknownEffectId).status,'outcome_unknown');
    assert.equal(await coldWorker.processNext(),false);
    assert.equal(replayCalls,0);
  } finally {
    if(service){await service.app.close();service.db.close();}
    if(db)db.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('SMS worker cancels a queued reply when its original owner binding is revoked',async()=>{
  const effectId=`sms-revoked-${randomUUID()}`,fixture=createQueuedSmsReply(effectId);
  try {
    const binding=fixture.bindings.resolve('alice',fixture.challenge.channel_binding_id);
    fixture.bindings.revoke('alice',binding.channel_binding_id,binding.version);
    let transportCalls=0;
    const provider=createTwilioSmsDeliveryProvider({accountSid,apiKeySid,apiKeySecret},fixture.db,async()=>{
      transportCalls+=1;return new Response(JSON.stringify({sid:'SMabcdef0123456789abcdef0123456789'}),{status:201});
    });
    const {store,worker}=createSmsWorker(fixture.db,provider);
    assert.equal(await worker.processNext(),true);
    assert.equal(transportCalls,0);
    assert.equal(store.get(effectId).status,'cancelled');
    assert.equal(store.get(effectId).last_reason_code,'SMS_REPLY_AUTHORITY_INVALID');
  } finally { fixture.db.close(); }
});

test('valid current SMS binding cannot bypass a revoked historical-final send gate',async()=>{
  const effectId=`sms-revoked-history-${randomUUID()}`,fixture=createQueuedSmsReply(effectId);
  try {
    const effect=fixture.db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?').get(effectId);
    const intentId=`sms-history-${randomUUID()}`,now=new Date().toISOString();
    const target={recipient_authorized:true,conversation_binding:{},effects:[{effect_id:effectId,generation:0,
      provider_receipt_json:null,status:'pending'}],protected_effect_ids:[]};
    fixture.db.prepare(`INSERT INTO ga_historical_final_delivery_batches
      (run_id,conversation_id,owner_id,message_id,text,content_sha256,publication_source_sha256,
       answer_sha256,snapshot_sha256,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(fixture.accepted.run_id,fixture.event.conversation_id,'alice',fixture.assistantMessageId,
        'reply text','invalid-content-hash','invalid-publication-hash','invalid-answer-hash',
        'invalid-snapshot-hash','{}',now);
    fixture.db.prepare(`INSERT INTO ga_historical_final_delivery_intents
      (intent_id,run_id,destination,recipient,target_json) VALUES(?,?,?,?,?)`)
      .run(intentId,fixture.accepted.run_id,'sms',fixture.principal,JSON.stringify(target));
    fixture.db.prepare(`INSERT INTO ga_historical_final_delivery_grants
      (effect_id,intent_id,payload_sha256) VALUES(?,?,?)`)
      .run(effectId,intentId,createHash('sha256').update(effect.payload_json).digest('hex'));
    fixture.db.prepare(`INSERT INTO ga_historical_final_delivery_states
      (intent_id,status,effect_id,decision_json,version,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(intentId,'queued',effectId,'{}',1,now);
    let transportCalls=0;
    const provider=createTwilioSmsDeliveryProvider({accountSid,apiKeySid,apiKeySecret},fixture.db,async()=>{
      transportCalls+=1;return new Response(JSON.stringify({sid:'SMabcdef0123456789abcdef0123456789'}),{status:201});
    });
    const store=new ChannelDeliveryService(fixture.db),authorizeSend=store.authorizeSend.bind(store);
    store.authorizeSend=(id,generation)=>{
      assert.ok(resolveTwilioSmsReplyContext(fixture.db,id),'the current SMS source and binding are valid');
      fixture.db.prepare("UPDATE ga_historical_final_delivery_states SET status='revoked',version=version+1,updated_at=? WHERE intent_id=?")
        .run(new Date().toISOString(),intentId);
      return authorizeSend(id,generation);
    };
    const worker=new ChannelDeliveryWorker(store,{providers:{sms:provider}},
      {async registerDeliveryReceipt(){throw new Error('SMS text must not request a Runtime receipt');}},
      {resolveRuntime(){throw new Error('SMS text must not resolve a Runtime');}});
    assert.equal(await worker.processNext(),true);
    assert.equal(transportCalls,0);
    assert.equal(store.get(effectId).status,'cancelled');
    assert.equal(store.get(effectId).last_reason_code,'HISTORICAL_FINAL_AUTHORITY_REVOKED');
  } finally { fixture.db.close(); }
});

test('Twilio provider rechecks binding after worker authorization when the principal is rebound',async()=>{
  const effectId=`sms-rebound-${randomUUID()}`,fixture=createQueuedSmsReply(effectId);
  try {
    const original=fixture.bindings.resolve('alice',fixture.challenge.channel_binding_id);
    let transportCalls=0,rebound;
    const provider=createTwilioSmsDeliveryProvider({accountSid,apiKeySid,apiKeySecret},fixture.db,async()=>{
      transportCalls+=1;return new Response(JSON.stringify({sid:'SMabcdef0123456789abcdef0123456789'}),{status:201});
    });
    const afterWorkerAuthorization={...provider,async sendWithKey(text,recipient,key){
      fixture.bindings.revoke('alice',original.channel_binding_id,original.version);
      const challenge=fixture.bindings.create('bob','sms',`sms-rebind-${randomUUID()}`);
      fixture.bindings.acceptProof('sms',fixture.principal,challenge.code);
      rebound=fixture.bindings.resolve('bob',challenge.channel_binding_id);
      assert.notEqual(rebound.channel_binding_id,original.channel_binding_id);
      assert.equal(resolveTwilioSmsReplyContext(fixture.db,key),undefined);
      return provider.sendWithKey(text,recipient,key);
    }};
    const {store,worker}=createSmsWorker(fixture.db,afterWorkerAuthorization);
    assert.equal(await worker.processNext(),true);
    assert.equal(fixture.db.prepare('SELECT owner_id FROM ga_owner_channel_bindings WHERE channel_binding_id=?')
      .get(rebound.channel_binding_id).owner_id,'bob');
    assert.equal(transportCalls,0);
    assert.equal(store.get(effectId).status,'cancelled');
    assert.equal(store.get(effectId).last_reason_code,'SMS_REPLY_AUTHORITY_INVALID');
  } finally { fixture.db.close(); }
});

test('SMS send requires the exact inbound run input and its assistant reply row',async()=>{
  for(const mismatch of ['run-input','assistant-message']){
    const effectId=`sms-source-${mismatch}-${randomUUID()}`,fixture=createQueuedSmsReply(effectId);
    try {
      if(mismatch==='run-input')fixture.db.prepare('UPDATE ga_runs SET input_message_id=? WHERE id=?')
        .run(fixture.assistantMessageId,fixture.accepted.run_id);
      else fixture.db.prepare('UPDATE ga_channel_deliveries SET message_id=? WHERE effect_id=?')
        .run(fixture.event.message_id,effectId);
      let transportCalls=0;
      const provider=createTwilioSmsDeliveryProvider({accountSid,apiKeySid,apiKeySecret},fixture.db,async()=>{
        transportCalls+=1;return new Response(JSON.stringify({sid:'SMabcdef0123456789abcdef0123456789'}),{status:201});
      });
      const {store,worker}=createSmsWorker(fixture.db,provider);
      assert.equal(await worker.processNext(),true);
      assert.equal(transportCalls,0,mismatch);
      assert.equal(store.get(effectId).status,'cancelled',mismatch);
      assert.equal(store.get(effectId).last_reason_code,'SMS_REPLY_AUTHORITY_INVALID',mismatch);
    } finally { fixture.db.close(); }
  }
});
