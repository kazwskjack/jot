import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './fixtures/mattermost-text-test-support.mjs';
test('accepted owner-proof post cannot be reinterpreted as ordinary text',async t=>{
 const f=await setup(t);await f.start();await f.emit();f.gateway.length=0;
 f.post={...f.post,message:'Rewritten proof as ordinary text'};await f.emit();
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_mattermost_text_observations').get().n,0);assert.equal(f.gateway.length,0);
 const body={channel:'mattermost',principal:JSON.stringify(['https://chat.example.test','bot-account','owner-user']),thread_id:JSON.stringify(['private-dm','']),message_id:f.post.id,text:'Rewritten proof as ordinary text',attachments:[]};
 assert.notEqual((await f.product.app.inject({method:'POST',url:'/internal/v1/channel/messages',headers:f.auth,payload:body})).statusCode,202);
});
for(const unknown of [false,true])test('original '+(unknown?'unknown':'admitted')+' text post cannot become a new owner proof after revocation',async t=>{
 const f=await setup(t);await f.start();await f.emit();f.controls.unknownBefore=unknown;f.post={...f.post,id:'immutable-text-post',message:'Original normal text'};await f.emit();
 const source=f.product.db.prepare('SELECT * FROM ga_mattermost_text_observations').get();assert.ok(source);f.controls.unknownBefore=false;
 f.product.db.prepare("UPDATE ga_owner_channel_bindings SET status='revoked',version=version+1 WHERE owner_id='alice'").run();
 const next=await f.create('bob','new-owner-challenge');f.post={...f.post,message:'/jot-bind '+next.code};f.gateway.length=0;await f.emit();
 assert.equal(f.product.db.prepare("SELECT count(*) n FROM ga_owner_channel_bindings WHERE owner_id='bob'").get().n,0);assert.equal(f.gateway.length,0);
 assert.deepEqual(f.product.db.prepare('SELECT * FROM ga_mattermost_text_observations').get(),source);
 const body={channel:'mattermost',principal:JSON.stringify(['https://chat.example.test','bot-account','owner-user']),thread_id:JSON.stringify(['private-dm','']),message_id:f.post.id,text:f.post.message,attachments:[]};
 assert.notEqual((await f.product.app.inject({method:'POST',url:'/internal/v1/channel/messages',headers:f.auth,payload:body})).statusCode,202);
});
