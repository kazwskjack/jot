import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import Fastify from 'fastify';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';
import { registerTwilioSmsRoutes } from '../../src/channels/sms-routes.ts';

const accountSid = ('AC' + '0'.repeat(30) + '01');
const authToken = 'twilio-auth-token-fixture';
const apiKeySid=('SK' + '0'.repeat(30) + '03');
const apiKeySecret='twilio-api-key-secret-fixture';
const webhookUrl = 'https://jot.example.test/hooks/v1/channels/sms?route=primary';
const from = '+14155550123';
const to = '+14155550999';
const messageSid = 'SM0123456789abcdef0123456789abcdef';
const mediaSid = 'ME0123456789abcdef0123456789abcdef';
const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}/Media/${mediaSid}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');

function signature(params) {
  const suffix = Object.keys(params).sort().map(key => {
    const value = params[key];
    return Array.isArray(value) ? [...new Set(value)].sort().map(item => key + item).join('') : key + value;
  }).join('');
  return createHmac('sha1', authToken).update(webhookUrl + suffix).digest('base64');
}

function form(params) {
  const body = new URLSearchParams(params).toString();
  return {body, headers:{'content-type':'application/x-www-form-urlencoded; charset=UTF-8','x-twilio-signature':signature(params)}};
}

test('signed MMS route fetches bounded media then stages and admits it through existing V2 intake', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const calls = [];
  const staged = [];
  const intake = {
    accept(input) { calls.push(['accept', input]); return {accepted:true}; },
    reserveAttachmentBatchV2(input, artifacts) {
      calls.push(['reserve', input, artifacts]);
      return {stage_key:'stage-fixture', source:{owner_id:'owner-1',channel_binding_id:'binding-1'}, parts:[{index:0}]};
    },
    async writeAttachmentBatchPartV2(owner,binding,key,index,bytes,artifacts) {
      const chunks=[]; for await (const chunk of bytes) chunks.push(Buffer.from(chunk));
      staged.push({owner,binding,key,index,bytes:Buffer.concat(chunks),artifacts});
    },
    async acceptAttachmentBatchV2(owner,binding,key,artifacts) {
      calls.push(['admit',owner,binding,key,artifacts]);
      return {accepted:true,message_id:'jot-sms-message',run_id:'sms-run-1',conversation_id:'sms-conversation-1'};
    },
  };
  const artifacts = {fixture:'artifacts'};
  const mediaRequests = [];
  registerTwilioSmsRoutes(app, {
    accountSid, authToken, webhookUrl, apiKeySid, apiKeySecret, intake, artifacts,
    mediaTransport: async (url, init) => {
      mediaRequests.push({url:String(url),init});
      return new Response(png, {status:200,headers:{'content-type':'image/png'}});
    },
  });
  const params={AccountSid:accountSid,From:from,To:to,Body:'caption',MessageSid:messageSid,
    NumMedia:'1',MediaContentType0:'image/png',MediaUrl0:mediaUrl};
  const sent=form(params);
  const response=await app.inject({method:'POST',url:'/hooks/v1/channels/sms',headers:sent.headers,payload:sent.body});
  assert.equal(response.statusCode,200,response.body);
  assert.match(response.headers['content-type'],/application\/xml/);
  assert.equal(response.body,'<?xml version="1.0" encoding="UTF-8"?><Response/>');
  assert.equal(mediaRequests.length,1);
  assert.equal(mediaRequests[0].url,mediaUrl);
  assert.equal(mediaRequests[0].init.redirect,'error');
  assert.equal(mediaRequests[0].init.headers.Authorization,`Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64')}`);
  assert.equal(calls[0][0],'reserve');
  const source=calls[0][1];
  assert.deepEqual(source.event,{channel:'sms',principal:`sms:${accountSid}:${from}`,thread_id:to,message_id:messageSid});
  assert.equal(source.text,'caption');
  assert.deepEqual(source.attachments,[{index:0,provider_file_id:`${messageSid}:media:0`,file_name:'media-0',media_type:'image/png',size_bytes:png.length,sha256:createHash('sha256').update(png).digest('hex')}]);
  assert.equal(calls[0][2],artifacts);
  assert.equal(staged.length,1);
  assert.deepEqual(staged[0].bytes,png);
  assert.deepEqual(calls.at(-1),['admit','owner-1','binding-1','stage-fixture',artifacts]);
  assert.equal(calls.some(call=>call[0]==='accept'),false);
});

test('invalid signatures and non-Twilio media URLs never fetch media or touch intake', async t => {
  const app=Fastify(); t.after(()=>app.close());
  let fetched=0,accepted=0,reserved=0;
  registerTwilioSmsRoutes(app,{accountSid,authToken,webhookUrl,apiKeySid,apiKeySecret,
    intake:{accept(){accepted++;return{};},reserveAttachmentBatchV2(){reserved++;throw new Error('unexpected');},
      async writeAttachmentBatchPartV2(){throw new Error('unexpected');},async acceptAttachmentBatchV2(){throw new Error('unexpected');}},
    artifacts:{},mediaTransport:async()=>{fetched++;return new Response(png);}});
  const params={AccountSid:accountSid,From:from,To:to,Body:'caption',MessageSid:messageSid,
    NumMedia:'1',MediaContentType0:'image/png',MediaUrl0:mediaUrl};
  const invalid=form(params); invalid.headers['x-twilio-signature']='A'.repeat(28);
  assert.equal((await app.inject({method:'POST',url:'/hooks/v1/channels/sms',headers:invalid.headers,payload:invalid.body})).statusCode,403);
  const hostile={...params,MediaUrl0:'https://127.0.0.1/private'}; const rejected=form(hostile);
  assert.equal((await app.inject({method:'POST',url:'/hooks/v1/channels/sms',headers:rejected.headers,payload:rejected.body})).statusCode,400);
  assert.equal(fetched,0); assert.equal(accepted,0); assert.equal(reserved,0);
});

test('media-only MMS is admitted instead of being discarded as an empty SMS', async t => {
  const app=Fastify(); t.after(()=>app.close());
  const params={AccountSid:accountSid,From:from,To:to,Body:'',MessageSid:messageSid,
    NumMedia:'1',MediaContentType0:'image/png',MediaUrl0:mediaUrl};
  let receivedText;
  registerTwilioSmsRoutes(app,{accountSid,authToken,webhookUrl,apiKeySid,apiKeySecret,
    intake:{accept(){throw new Error('text admission not expected');},reserveAttachmentBatchV2(input){receivedText=input.text;return{stage_key:'stage',source:{owner_id:'owner',channel_binding_id:'binding'},parts:[{}]};},
      async writeAttachmentBatchPartV2(){},async acceptAttachmentBatchV2(){return{accepted:true};}},
    artifacts:{},mediaTransport:async()=>new Response(png,{status:200,headers:{'content-type':'image/png'}})});
  const sent=form(params),response=await app.inject({method:'POST',url:'/hooks/v1/channels/sms',headers:sent.headers,payload:sent.body});
  assert.equal(response.statusCode,200,response.body); assert.equal(receivedText,'');
});

test('configured gateway route verifies an SMS binding proof before admitting later messages',async t=>{
  const csrfToken='sms-route-csrf-fixture-token-123456';
  const service=await buildServer({databasePath:':memory:',workspaces:['sms-route-workspace'],csrfToken,
    allowedOrigins:['https://fixture.invalid'],internalChannelToken:'sms-internal-fixture-token-123456',
    uploadRoot:'test-tmp/sms-route-files',workbenchRoot:'test-tmp/sms-route-workbench',
    smsWebhook:{accountSid,authToken,webhookUrl,apiKeySid,apiKeySecret}});
  t.after(async()=>{await service.app.close();service.db.close();});
  const headers={'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':csrfToken,'idempotency-key':'sms-bind-fixture-key'};
  const binding=await service.app.inject({method:'POST',url:'/v1/channel-bindings',headers,payload:{channel:'sms'}});
  assert.equal(binding.statusCode,201,binding.body);
  const code=binding.json().code;
  const bindParams={AccountSid:accountSid,From:from,To:to,Body:`/jot-bind ${code}`,MessageSid:'SM1123456789abcdef0123456789abcdef',NumMedia:'0'};
  const bindRequest=form(bindParams);
  const proof=await service.app.inject({method:'POST',url:'/hooks/v1/channels/sms',headers:bindRequest.headers,payload:bindRequest.body});
  assert.equal(proof.statusCode,200,proof.body);
  const verified=await service.app.inject({url:'/v1/channel-bindings',headers:{'x-user-id':'alice'}});
  assert.equal(verified.json().items[0].status,'verified');
  assert.equal(verified.json().items[0].channel,'sms');

  const messageParams={...bindParams,Body:'hello from SMS',MessageSid:messageSid};
  const messageRequest=form(messageParams);
  const first=await service.app.inject({method:'POST',url:'/hooks/v1/channels/sms',headers:messageRequest.headers,payload:messageRequest.body});
  const replay=await service.app.inject({method:'POST',url:'/hooks/v1/channels/sms',headers:messageRequest.headers,payload:messageRequest.body});
  assert.equal(first.statusCode,200,first.body); assert.equal(replay.statusCode,200,replay.body);
  assert.equal(service.db.prepare("SELECT count(*) AS n FROM ga_channel_message_events WHERE channel='sms'").get().n,1);
  const capabilities=await service.app.inject({url:'/v1/capabilities',headers:{'x-user-id':'alice'}});
  assert.equal(capabilities.json().workbench.sms_bindings,true);
});
