import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {buildServer} from '../src/server.mjs';
import {Agent} from '../src/agent.mjs';

test('standalone legacy database migrates as Work and accepted mode survives disk reopen',async()=>{
 const scratch=resolve(tmpdir()),root=await mkdtemp(join(scratch,'jot-mode-store-')),path=join(root,'state.db');let store;
 try{
  const old=new DatabaseSync(path);old.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL); INSERT INTO conversations VALUES('old','Old','2020-01-01T00:00:00.000Z'); CREATE TABLE runs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,UNIQUE(conversation_id,request_id)); INSERT INTO runs VALUES('old-run','old','old-key','original','succeeded',NULL,'2020-01-01T00:00:00.000Z')");old.close();
  store=new Store(path);assert.equal(store.conversation('old').mode,'work');assert.equal(store.conversation('old').version,1);assert.equal(store.run('old-run').mode,'work');assert.equal(store.run('old-run').conversation_version,1);
  const accepted=store.accept('old','new input','new-key');assert.equal(accepted.run.mode,'work');assert.equal(accepted.run.conversation_version,1);store.state(accepted.run.id,'succeeded');
  const changed=store.changeMode('old','chat',1);assert.equal(changed.mode,'chat');assert.equal(changed.version,2);assert.equal(store.run(accepted.run.id).mode,'work');
  const repeated=store.accept('old','new input','new-key');assert.equal(repeated.duplicate,true);assert.equal(repeated.run.id,accepted.run.id);assert.equal(repeated.run.mode,'work');assert.throws(()=>store.accept('old','changed input','new-key'),/idempotency_conflict/);
  store.close();store=new Store(path);assert.equal(store.conversation('old').mode,'chat');assert.equal(store.run(accepted.run.id).mode,'work');assert.throws(()=>store.changeMode('old','work',1),/version_conflict/);assert.equal(store.conversation('old').version,2);
 }finally{store?.close();assert.ok(root.startsWith(scratch+sep));await rm(root,{recursive:true,force:true});}
});

test('mode CAS is atomic with queued, running and approval-waiting exclusion',()=>{
 const store=new Store(':memory:');try{
  for(const status of ['queued','running','waiting_approval']){
   const c=store.createConversation(),{run}=store.accept(c.id,'hello','input');if(status!=='queued')store.state(run.id,status);
   assert.throws(()=>store.changeMode(c.id,'chat',1),/conversation_busy/);assert.equal(store.conversation(c.id).mode,'work');assert.equal(store.conversation(c.id).version,1);store.state(run.id,'cancelled');
   assert.equal(store.changeMode(c.id,'chat',1).version,2);assert.throws(()=>store.changeMode(c.id,'work',1),/version_conflict/);assert.equal(store.accept(c.id,'next','next',{chatReady:true}).run.mode,'chat');
  }
  assert.throws(()=>store.changeMode('missing','work',1),/conversation_not_found/);const c=store.createConversation();assert.throws(()=>store.changeMode(c.id,'other',1),/invalid_mode/);assert.throws(()=>store.changeMode(c.id,'work',0),/invalid_version/);
 }finally{store.close();}
});

test('standalone API exposes unavailable Chat and enforces versioned Work changes without silently executing Chat',async()=>{
 let calls=0;const service=await buildServer({database:':memory:',provider:async()=>{calls++;return{role:'assistant',content:'fixture'};}});
 try{
  const caps=(await service.app.inject({url:'/api/capabilities'})).json();assert.deepEqual(caps.conversation_modes,{default:'work',work:{supported:true},chat:{ready:false}});const headers={'x-jot-token':caps.csrf};
  const create=await service.app.inject({method:'POST',url:'/api/conversations',headers,payload:{title:'test',mode:'work'}});assert.equal(create.statusCode,200);const c=create.json();assert.equal(c.version,1);
  const blocked=await service.app.inject({method:'POST',url:'/api/conversations',headers,payload:{mode:'chat'}});assert.equal(blocked.statusCode,409);assert.equal(blocked.json().error,'chat_unavailable');assert.equal(service.store.conversations().length,1);
  const route='/api/conversations/'+c.id;const change=payload=>service.app.inject({method:'PATCH',url:route,headers,payload});
  assert.equal((await service.app.inject({method:'PATCH',url:route,payload:{mode:'work',expected_version:1}})).statusCode,403);
  assert.equal((await service.app.inject({method:'PATCH',url:route,headers:{...headers,origin:'https://untrusted.example'},payload:{mode:'work',expected_version:1}})).statusCode,403);
  assert.equal((await change({mode:'work',expected_version:1})).json().version,2);assert.equal((await change({mode:'work',expected_version:1})).statusCode,409);assert.equal((await change({mode:'chat',expected_version:2})).statusCode,409);
  // The existing Fastify configuration strips unknown input fields. They must
  // never become a model selection or accepted execution policy.
  const extra=await change({mode:'work',expected_version:2,model:'untrusted'});assert.equal(extra.statusCode,200);assert.equal(extra.json().model,undefined);
  // A stored unsupported mode must never fall through to the Work provider.
  service.store.changeMode(c.id,'chat',3);const send=await service.app.inject({method:'POST',url:route+'/messages',headers,payload:{text:'do not dispatch',request_id:'unsupported'}});assert.equal(send.statusCode,409);assert.equal(service.store.runs(c.id).length,0);assert.equal(calls,0);
 }finally{await service.close();}
});

test('Agent uses the persisted accepted mode instead of a caller-supplied Work label',async()=>{
 const store=new Store(':memory:');let calls=0;const agent=new Agent(store,{provider:async()=>{calls++;return{role:'assistant',content:'wrong route'};},tools:{definitions:[],execute:async()=>{throw Error('unexpected tool');}}});
 try{const c=store.createConversation('internal fixture','chat'),{run}=store.accept(c.id,'hello','original',{chatReady:true});await agent.execute({...run,mode:'work'});assert.equal(calls,0);assert.equal(store.run(run.id).status,'failed');assert.equal(store.run(run.id).error,'model_chat_unavailable');}
 finally{await agent.close();store.close();}
});
