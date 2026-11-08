import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';

const instance='https://chat.example.test',bot='bot-account',user='owner-user',channel='private-dm';
class Socket extends EventTarget{
 static latest;
 constructor(){super();Socket.latest=this;queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
 send(raw){const value=JSON.parse(raw);assert.equal(value.action,'authentication_challenge');queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({status:'OK',seq_reply:value.seq})})));}
 close(){this.closed=true;}
 posted(post){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({event:'posted',data:{post:JSON.stringify(post)}})}));}
}
async function setup(t){
 const parent=resolve('test-tmp');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'mattermost-owner-'));
 const token='synthetic-mattermost-internal-token',csrf='synthetic-mattermost-csrf';
 const product=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],internalChannelToken:token,templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),
  csrfToken:csrf,allowedOrigins:['https://fixture.invalid'],mattermostOwnerBinding:{instance,botUserId:bot}});
 let service; t.after(async()=>{await service?.uninstall();await product.app.close();product.db.close();const rel=relative(parent,root);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const create=async(owner='alice',key='mattermost-owner-challenge')=>{
  const response=await product.app.inject({method:'POST',url:'/v1/channel-bindings',headers:{'x-user-id':owner,origin:'https://fixture.invalid','x-csrf-token':csrf,'idempotency-key':key},payload:{channel:'mattermost'}});
  assert.equal(response.statusCode,201,response.body);return response.json();};
 const challenge=await create();let post={id:'post-proof',user_id:user,channel_id:channel,root_id:'',message:'/jot-bind '+challenge.code,file_ids:[],type:'',delete_at:0,edit_at:0};
 const controls={type:'D',members:[bot,user],failPage:false,loseAck:false,unknownBefore:false,malformed:false,pauseMembers:false},http=[],gateway=[];
 const transport=async(input,init)=>{const url=new URL(input);http.push(url.pathname+url.search);assert.equal(url.origin,instance);assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer synthetic-bot-token');
  if(url.pathname.endsWith('/users/me'))return Response.json({id:bot});
  if(url.pathname.endsWith('/posts/'+post.id))return Response.json(post);
  if(url.pathname.endsWith('/channels/'+channel))return Response.json({id:channel,type:controls.type,delete_at:0});
  if(url.pathname.endsWith('/members')){if(controls.pauseMembers){controls.entered?.();await new Promise((_,reject)=>{if(init.signal.aborted)reject(Error('aborted'));else init.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});}const page=Number(url.searchParams.get('page'));if(controls.failPage&&page===1)throw Error('synthetic_page_unavailable');return Response.json(controls.members.slice(page*2,(page+1)*2).map(user_id=>({user_id,channel_id:channel})));}
  throw Error('unexpected_api:'+url.pathname);
 };
 const gatewayFetch=async(input,init)=>{const url=new URL(input).pathname;gateway.push(url);if(url==='/internal/v1/channel/messages'&&controls.unknownBefore)throw Error('synthetic_unknown_before_dispatch');if(url==='/internal/v1/channel/messages'&&controls.malformed)return Response.json({accepted:true,message_id:'bad',run_id:'bad',conversation_id:'bad'},{status:202});const response=await product.app.inject({method:init.method,url,headers:init.headers,payload:init.body});if(controls.loseAck&&url==='/internal/v1/channel/messages'){controls.loseAck=false;throw Error('synthetic_lost_ack');}return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});};
 const start=async()=>{const {startMattermostOwnerService}=await import('../../src/channels/mattermost-owner-service.ts');service=await startMattermostOwnerService({GENERAL_AGENT_MATTERMOST_BASE_URL:instance,GENERAL_AGENT_MATTERMOST_BOT_USER_ID:bot,GENERAL_AGENT_MATTERMOST_BOT_TOKEN:'synthetic-bot-token',GENERAL_AGENT_GATEWAY_INTERNAL_URL:'http://127.0.0.1:18831',GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN:token},{db:product.db,fetch:transport,gatewayFetch,socketFactory:()=>new Socket(),memberPageSize:2});await service.idle();return service;};
 return {product,challenge,controls,http,gateway,create,start,get service(){return service;},get post(){return post;},set post(value){post=value;},emit:async notification=>{Socket.latest.posted(notification??post);await service.idle();},close:async()=>service.uninstall(),auth:{authorization:'Bearer '+token}};
}

test('actual Mattermost service private proof reaches original Gateway; lost ACK and duplicate event only look up original receipt',async t=>{
 const f=await setup(t);f.controls.loseAck=true;await f.start();await f.emit();
 assert.equal(f.product.db.prepare("SELECT count(*) n FROM ga_owner_channel_bindings WHERE channel='mattermost' AND status='verified'").get().n,1);
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
 assert.ok(f.http.some(path=>path.includes('page=1')));assert.deepEqual(f.gateway,['/internal/v1/channel/messages','/internal/v1/channel/mattermost/proof-receipt']);
 f.gateway.length=0;await f.emit();assert.deepEqual(f.gateway,['/internal/v1/channel/mattermost/proof-receipt']);
 await f.close();f.gateway.length=0;await f.start();assert.deepEqual(f.gateway,['/internal/v1/channel/mattermost/proof-receipt']);
 const bindings=await f.product.app.inject({url:'/v1/channel-bindings',headers:{'x-user-id':'bob'}});assert.equal(bindings.json().items.length,0);
 assert.equal(JSON.stringify(f.product.db.prepare('SELECT * FROM ga_mattermost_ingress_observations').all()).includes(f.challenge.code),false);
});

test('authoritative post mismatch, non-DM, third member and incomplete member pagination cannot consume owner proof',async t=>{
 for(const reason of ['mismatch','public','third','page'])await t.test(reason,async t=>{
  const f=await setup(t);if(reason==='public')f.controls.type='O';if(reason==='third')f.controls.members.push('third-user');if(reason==='page')f.controls.failPage=true;
  await f.start();await f.emit(reason==='mismatch'?{...f.post,user_id:'forged-user'}:undefined);
  assert.equal(f.gateway.length,0);assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_owner_channel_bindings').get().n,0);
 });
});

test('expired challenge does not bind; uninstall prevents later callbacks',async t=>{
 const f=await setup(t);f.product.db.prepare('UPDATE ga_owner_channel_challenges SET expires_at=0').run();await f.start();await f.emit();
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_owner_channel_bindings').get().n,0);
 await f.close();const count=f.gateway.length;await f.emit();assert.equal(f.gateway.length,count);
});

test('replaced challenge and changed original post cannot consume or move binding',async t=>{
 const f=await setup(t);await f.create('alice','mattermost-new-challenge');await f.start();await f.emit();
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_owner_channel_bindings').get().n,0);
 const next=await f.create('alice','mattermost-next-challenge');f.post={...f.post,id:'new-valid-proof',message:'/jot-bind '+next.code};await f.emit();
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_mattermost_owner_proofs').get().n,1);
 const priorCalls=f.gateway.length;f.post={...f.post,message:f.post.message+' changed'};await f.emit();assert.equal(f.gateway.length,priorCalls);
});

test('observed unknown source cannot dispatch again after restart; malformed receipt is not a binding receipt',async t=>{
 for(const mode of ['unknownBefore','malformed'])await t.test(mode,async t=>{
  const f=await setup(t);f.controls[mode]=true;await f.start();await f.emit();assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_owner_channel_bindings').get().n,0);
  if(mode==='malformed')assert.equal(f.service.lastError(),'mattermost_binding_receipt_invalid');
  await f.close();f.gateway.length=0;await f.start();assert.deepEqual(f.gateway,['/internal/v1/channel/mattermost/proof-receipt']);
 });
});

test('consumed proof cannot move to another post/owner; revoked binding and foreign lookup do not recover verified',async t=>{
 const f=await setup(t);await f.start();await f.emit();
 const original=f.product.db.prepare('SELECT * FROM ga_mattermost_owner_proofs').get();
 const lookup={principal:original.principal,thread_id:original.provider_thread_id,message_id:original.post_id,source_sha256:original.source_sha256},url='/internal/v1/channel/mattermost/proof-receipt';
 assert.equal((await f.product.app.inject({method:'POST',url,payload:lookup})).statusCode,401);
 for(const change of [{principal:JSON.stringify(['https://other.example',bot,user])},{thread_id:JSON.stringify(['another-dm',''])},{source_sha256:'f'.repeat(64)},{owner_id:'bob'}]){
  assert.equal((await f.product.app.inject({method:'POST',url,headers:f.auth,payload:{...lookup,...change}})).json().state,'unproven');
 }
 f.post={...f.post,id:'another-post'};await f.emit();assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_mattermost_owner_proofs').get().n,1);
 const bob=await f.create('bob','mattermost-bob-challenge');f.post={...f.post,id:'bob-post',message:'/jot-bind '+bob.code};await f.emit();
 assert.equal(f.product.db.prepare("SELECT count(*) n FROM ga_owner_channel_bindings WHERE owner_id='bob'").get().n,0);
 f.product.db.prepare("UPDATE ga_owner_channel_bindings SET status='revoked',version=version+1 WHERE channel_binding_id=?").run(original.channel_binding_id);
 assert.equal((await f.product.app.inject({method:'POST',url,headers:f.auth,payload:lookup})).json().state,'unproven');
});

test('uninstall aborts an in-flight member read before original intake dispatch',async t=>{
 const f=await setup(t);let entered;const started=new Promise(resolve=>entered=resolve);f.controls.pauseMembers=true;f.controls.entered=entered;
 await f.start();const operation=f.emit();await started;await f.close();await operation;
 assert.equal(f.gateway.length,0);assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_mattermost_ingress_observations').get().n,0);
});

test('startup recovers durable observation without another WebSocket notification or provider post read',async t=>{
 const f=await setup(t);f.controls.unknownBefore=true;await f.start();await f.emit();await f.close();
 f.gateway.length=0;f.http.length=0;await f.start();
 assert.deepEqual(f.gateway,['/internal/v1/channel/mattermost/proof-receipt']);
 assert.deepEqual(f.http,['/api/v4/users/me']);
 assert.equal(f.product.db.prepare('SELECT count(*) n FROM ga_owner_channel_bindings').get().n,0);
});

test('startup pages all frozen observations, including more than one page, without dispatch',async t=>{
 const f=await setup(t),db=f.product.db;
 const insert=db.prepare('INSERT INTO ga_mattermost_ingress_observations(instance,bot_user_id,post_id,principal,provider_thread_id,source_sha256,created_at) VALUES(?,?,?,?,?,?,?)');
 for(let i=0;i<35;i++)insert.run(instance,bot,'prior-'+String(i).padStart(2,'0'),JSON.stringify([instance,bot,user]),JSON.stringify([channel,'']),'a'.repeat(64),i);
 await f.start();assert.equal(f.gateway.length,35);assert.ok(f.gateway.every(url=>url==='/internal/v1/channel/mattermost/proof-receipt'));
 assert.equal(db.prepare('SELECT count(*) n FROM ga_owner_channel_bindings').get().n,0);
});
