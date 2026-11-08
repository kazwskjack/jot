import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './fixtures/mattermost-file-test-support.mjs';
import {createHash} from 'node:crypto';
const prefix='/internal/v2/channel/attachment-batches';
async function bound(t){const f=await setup(t);await f.start();await f.emit();f.gateway.length=0;f.http.length=0;f.post={...f.post,id:'file-post',message:'Read exact attachment',file_ids:['provider-file']};return f;}
test('Mattermost canonical file source reaches original v2 admission and restart only looks up original batch',async t=>{
 const f=await bound(t);f.controls.loseAck=true;await f.emit();
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1,JSON.stringify({error:f.service.lastError(),gateway:f.gateway,http:f.http}));assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_artifacts').get().n,1);
 const original=f.product.db.prepare("SELECT * FROM ga_channel_message_events WHERE channel='mattermost'").get();assert.equal(original.content_protocol,2);
 const source=JSON.parse(original.attachments_json).source;assert.equal(source.owner_id,'alice');assert.equal(source.attachments[0].provider_file_id,'provider-file');assert.equal(source.attachments[0].sha256,createHash('sha256').update(f.controls.fileBytes).digest('hex'));
 const obs=f.product.db.prepare('SELECT * FROM ga_mattermost_attachment_observations').get();assert.equal(obs.owner_id,'alice');assert.equal(obs.binding_version,original.binding_version);
 f.gateway.length=0;f.http.length=0;await f.emit();assert.deepEqual(f.gateway,[prefix+'/lookup']);assert.equal(f.http.some(url=>/\/files\//.test(url)),false);
 await f.close();f.gateway.length=0;f.http.length=0;await f.start();assert.ok(f.gateway.includes(prefix+'/lookup'));assert.ok(f.gateway.every(url=>url.endsWith('/lookup')||url.endsWith('proof-receipt')));assert.deepEqual(f.http,['/api/v4/users/me']);
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});
test('wrong file owner/post/name/type/size and redirect cannot create stages or runs',async t=>{
 for(const kind of ['owner','post','name','type','size','redirect'])await t.test(kind,async t=>{
  const f=await bound(t);if(kind==='owner')f.controls.fileInfos[0].user_id='foreign-user';if(kind==='post')f.controls.fileInfos[0].post_id='foreign-post';if(kind==='name')f.controls.fileInfos[0].name='../bad';if(kind==='type')f.controls.badType='image/png';if(kind==='size')f.controls.fileInfos[0].size=101*1024*1024;if(kind==='redirect')f.controls.redirect=true;
  await f.emit();assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_uploads').get().n,0);assert.equal(f.gateway.length,0);
 });
});
test('stage-only and changed source remain held across callbacks/restart without another reservation or download',async t=>{
 const f=await bound(t);f.controls.loseReserveAck=true;await f.emit();assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_uploads').get().n,1);assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
 const original=f.product.db.prepare('SELECT * FROM ga_mattermost_attachment_observations').get();f.gateway.length=0;f.http.length=0;await f.emit();assert.deepEqual(f.gateway,[prefix+'/lookup']);assert.equal(f.http.length,0);
 f.post={...f.post,message:'Changed caption'};f.gateway.length=0;await f.emit();assert.equal(f.gateway.length,0);assert.deepEqual(f.product.db.prepare('SELECT * FROM ga_mattermost_attachment_observations').get(),original);
 await f.close();f.gateway.length=0;f.http.length=0;await f.start();assert.ok(f.gateway.includes(prefix+'/lookup'));assert.ok(!f.gateway.includes(prefix));assert.deepEqual(f.http,['/api/v4/users/me']);assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
test('file observations cannot turn into text/proof, change root or move to a new owner generation',async t=>{
 const f=await bound(t);f.controls.loseReserveAck=true;await f.emit();f.gateway.length=0;const source=f.product.db.prepare('SELECT * FROM ga_mattermost_attachment_observations').get();
 f.post={...f.post,file_ids:[],message:'Rewritten file as text'};await f.emit();assert.equal(f.gateway.length,0);
 f.product.db.prepare("UPDATE ga_owner_channel_bindings SET status='revoked',version=version+1 WHERE owner_id='alice'").run();const challenge=await f.create('bob','file-source-bob');f.post={...f.post,message:'/jot-bind '+challenge.code};await f.emit();assert.equal(f.gateway.length,0);assert.equal(f.product.db.prepare("SELECT count(*) n FROM ga_owner_channel_bindings WHERE owner_id='bob'").get().n,0);
 assert.deepEqual(f.product.db.prepare('SELECT * FROM ga_mattermost_attachment_observations').get(),source);assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
test('original bare stage cannot change account/post thread or be reinterpreted as a normal text event',async t=>{
 const f=await bound(t),declaration={protocol:2,event:{channel:'mattermost',principal:JSON.stringify(['https://chat.example.test','bot-account','owner-user']),thread_id:JSON.stringify(['private-dm','']),message_id:'file-post'},text:'Read exact attachment',attachments:[{index:0,provider_file_id:'provider-file',file_name:'one.txt',media_type:'text/plain',size_bytes:f.controls.fileBytes.length,sha256:createHash('sha256').update(f.controls.fileBytes).digest('hex')}]};
 assert.equal((await f.product.app.inject({method:'POST',url:prefix,headers:f.auth,payload:declaration})).statusCode,201);
 const altered={...declaration,event:{...declaration.event,thread_id:JSON.stringify(['private-dm','another-root'])}};
 assert.equal((await f.product.app.inject({method:'POST',url:prefix,headers:f.auth,payload:altered})).statusCode,409);assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_uploads').get().n,1);
 f.post={...f.post,file_ids:[],message:'Rewritten bare stage'};await f.emit();assert.equal(f.gateway.length,0);assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
test('uninstall cancels a file stream before any observation, reservation or admission',async t=>{
 const f=await bound(t);let entered;const reading=new Promise(resolve=>entered=resolve);f.controls.pauseFile=true;f.controls.enteredFile=entered;
 const operation=f.emit();await reading;await f.close();await operation;assert.equal(f.controls.fileCancelled,true);assert.equal(f.gateway.length,0);assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_mattermost_attachment_observations').get().n,0);assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
