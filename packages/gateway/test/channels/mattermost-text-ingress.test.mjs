import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './fixtures/mattermost-text-test-support.mjs';
const receiptPath='/internal/v1/channel/mattermost/event-receipt';
async function bound(t){const f=await setup(t);await f.start();await f.emit();f.gateway.length=0;return f;}
const events=f=>f.product.db.prepare("SELECT * FROM ga_channel_message_events WHERE channel='mattermost' ORDER BY provider_message_id").all();
test('Mattermost ordinary text reaches original owner conversation; lost ACK and restart use only original event lookup',async t=>{
 const f=await bound(t);f.controls.loseAck=true;f.post={...f.post,id:'ordinary-post',message:'Read this original text'};await f.emit();
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);const original=events(f)[0];assert.ok(original?.run_id);
 assert.deepEqual(f.gateway,['/internal/v1/channel/messages',receiptPath]);
 assert.equal(f.product.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(original.conversation_id).owner_id,'alice');
 f.gateway.length=0;await f.emit();assert.deepEqual(f.gateway,[receiptPath]);assert.equal(events(f).length,1);
 await f.close();f.gateway.length=0;f.http.length=0;await f.start();assert.ok(f.gateway.includes(receiptPath));assert.ok(!f.gateway.includes('/internal/v1/channel/messages'));assert.deepEqual(f.http,['/api/v4/users/me']);assert.equal(events(f).length,1);
 const observation=f.product.db.prepare('SELECT * FROM ga_mattermost_text_observations').get();assert.equal(observation.channel_binding_id,original.channel_binding_id);assert.equal(observation.binding_version,original.binding_version);assert.equal(observation.owner_id,'alice');assert.equal(observation.source_sha256,original.event_sha256);
 const wire=JSON.parse(observation.source_json),request={method:'POST',url:receiptPath,headers:f.auth,payload:wire};
 const lookup=await f.product.app.inject(request);assert.equal(lookup.json().state,'observed');assert.deepEqual(lookup.json().receipt,{accepted:true,message_id:original.message_id,run_id:original.run_id,conversation_id:original.conversation_id});
 assert.equal((await f.product.app.inject({...request,headers:{}})).statusCode,401);
 for(const change of [{owner_id:'bob'},{text:'Changed'},{thread_id:JSON.stringify(['foreign-dm',''])},{principal:JSON.stringify(['https://foreign.test','bot-account','owner-user'])}])assert.notEqual((await f.product.app.inject({...request,payload:{...wire,...change}})).json().state,'observed');
 f.product.db.prepare('UPDATE ga_owner_channel_bindings SET version=version+1 WHERE channel_binding_id=?').run(original.channel_binding_id);assert.notEqual((await f.product.app.inject(request)).json().state,'observed');assert.equal(events(f).length,1);
});

test('canonical root maps stable original thread; changed root, text and foreign root cannot fork a provider post',async t=>{
 const f=await bound(t);const root=id=>({...f.post,id,root_id:'',message:'Original root'});f.controls.roots={'root-one':root('root-one'),'root-two':root('root-two'),'foreign-root':{...root('foreign-root'),channel_id:'foreign-dm'}};
 f.post={...f.post,id:'reply-one',root_id:'root-one',message:'Reply one'};await f.emit();assert.equal(events(f).length,1);
 const first=events(f)[0];f.post={...f.post,id:'reply-two',message:'Reply two'};await f.emit();assert.equal(events(f).length,2);assert.ok(events(f).every(row=>row.conversation_id===first.conversation_id));
 f.gateway.length=0;f.post={...f.post,message:'Changed original text'};await f.emit();assert.equal(f.gateway.length,0);assert.equal(events(f).length,2);
 f.post={...f.post,id:'reply-one',root_id:'root-two',message:'Reply one'};f.gateway.length=0;await f.emit();assert.equal(f.gateway.length,0);assert.equal(events(f).length,2);
 f.post={...f.post,id:'foreign-reply',root_id:'foreign-root'};await f.emit();assert.equal(events(f).length,2);
 const wire={channel:'mattermost',principal:first.principal,thread_id:JSON.stringify(['private-dm','root-two']),message_id:'reply-one',text:'Reply one',attachments:[]};
 const wrong=await f.product.app.inject({method:'POST',url:'/internal/v1/channel/messages',headers:f.auth,payload:wire});assert.notEqual(wrong.statusCode,202);assert.equal(events(f).length,2);
});

test('unobserved text remains unknown on restart without dispatch or original source replacement',async t=>{
 const f=await bound(t);f.controls.unknownBefore=true;f.post={...f.post,id:'unknown-text',message:'Uncertain source'};await f.emit();assert.equal(events(f).length,0);
 const rows=f.product.db.prepare('SELECT * FROM ga_mattermost_text_observations').all();assert.equal(rows.length,1);await f.close();f.gateway.length=0;await f.start();assert.ok(f.gateway.includes(receiptPath));assert.ok(!f.gateway.includes('/internal/v1/channel/messages'));assert.equal(events(f).length,0);assert.deepEqual(f.product.db.prepare('SELECT * FROM ga_mattermost_text_observations').all(),rows);
});

test('another verified owner cannot reuse the same account/post identity or obtain its receipt',async t=>{
 const f=await bound(t);f.post={...f.post,id:'alice-original',message:'Alice text'};await f.emit();const original=events(f)[0];
 const bob=await f.create('bob','mattermost-text-bob'),principal=JSON.stringify(['https://chat.example.test','bot-account','bob-user']),thread=JSON.stringify(['bob-dm','']);
 const proof=await f.product.app.inject({method:'POST',url:'/internal/v1/channel/messages',headers:f.auth,payload:{channel:'mattermost',principal,thread_id:thread,message_id:'bob-proof',text:'/jot-bind '+bob.code,attachments:[]}});assert.equal(proof.statusCode,202,proof.body);
 const wire={channel:'mattermost',principal,thread_id:thread,message_id:'alice-original',text:'Alice text',attachments:[]};
 assert.notEqual((await f.product.app.inject({method:'POST',url:'/internal/v1/channel/messages',headers:f.auth,payload:wire})).statusCode,202);
 assert.notEqual((await f.product.app.inject({method:'POST',url:receiptPath,headers:f.auth,payload:wire})).json().state,'observed');
 assert.equal(events(f).length,1);assert.equal(events(f)[0].run_id,original.run_id);
});

test('ordinary text rejects a changed member set and cancellation before dispatch',async t=>{
 const f=await bound(t);f.controls.members.push('third');f.post={...f.post,id:'shared-text',message:'No shared admission'};await f.emit();assert.equal(events(f).length,0);assert.equal(f.gateway.length,0);
 f.controls.members.pop();let entered;const inRead=new Promise(resolve=>entered=resolve);f.controls.pauseMembers=true;f.controls.entered=entered;
 f.post={...f.post,id:'cancelled-text'};const operation=f.emit();await inRead;await f.close();await operation;
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_mattermost_text_observations').get().n,0);assert.equal(events(f).length,0);
});
