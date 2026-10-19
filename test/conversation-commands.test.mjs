import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';
import {Store} from '../src/store.mjs';import {buildServer} from '../src/server.mjs';
test('create and mode receipts survive disk reopen and restore only the original outcome',async()=>{
 const scratch=resolve(tmpdir()),root=await mkdtemp(join(scratch,'jot-command-'));let store;
 try{store=new Store(join(root,'db.sqlite'));const c=store.createConversation('original','chat',{requestId:'create-one',chatReady:true});assert.deepEqual(store.createConversation('original','chat',{requestId:'create-one',chatReady:false}),c);assert.equal(store.conversations().length,1);assert.throws(()=>store.createConversation('changed','chat',{requestId:'create-one',chatReady:true}),/idempotency_conflict/);
 const changed=store.changeMode(c.id,'work',1,{requestId:'mode-one'});assert.equal(changed.version,2);const {run}=store.accept(c.id,'busy','original');assert.deepEqual(store.changeMode(c.id,'work',1,{requestId:'mode-one'}),changed);assert.throws(()=>store.changeMode(c.id,'chat',2,{requestId:'mode-one'}),/idempotency_conflict/);assert.equal(store.conversation(c.id).version,2);
 store.state(run.id,'succeeded');store.close();store=new Store(join(root,'db.sqlite'));assert.deepEqual(store.createConversation('original','chat',{requestId:'create-one',chatReady:false}),c);assert.deepEqual(store.changeMode(c.id,'work',1,{requestId:'mode-one'}),changed);assert.equal(store.conversations().length,1);assert.throws(()=>store.changeMode(c.id,'work',2,{requestId:'create-one'}),/idempotency_conflict/);
 }finally{store?.close();assert.ok(root.startsWith(scratch+sep));await rm(root,{recursive:true,force:true});}
});
test('a rejected mutation leaves no success receipt and never consumes another command',()=>{
 const store=new Store(':memory:');try{assert.throws(()=>store.createConversation('unavailable','chat',{requestId:'not-yet',chatReady:false}),/chat_unavailable/);assert.equal(store.conversations().length,0);const c=store.createConversation('available','work',{requestId:'not-yet'});assert.equal(c.version,1);assert.throws(()=>store.changeMode(c.id,'work',99,{requestId:'stale'}),/version_conflict/);assert.equal(store.changeMode(c.id,'work',1,{requestId:'stale'}).version,2);}finally{store.close();}
});
test('actual standalone API accepts optional original command IDs while legacy creation remains Work',async()=>{
 const service=await buildServer({database:':memory:',chat:{enabled:false}});try{const headers={'x-jot-token':(await service.app.inject({url:'/api/capabilities'})).json().csrf};const create=()=>service.app.inject({method:'POST',url:'/api/conversations',headers,payload:{title:'same',mode:'work',request_id:'create-req'}});const a=await create(),b=await create();assert.equal(a.statusCode,200);assert.equal(b.json().id,a.json().id);assert.equal(service.store.conversations().length,1);
 const change=payload=>service.app.inject({method:'PATCH',url:'/api/conversations/'+a.json().id,headers,payload});const body={mode:'work',expected_version:1,request_id:'mode-req'};const first=await change(body),repeat=await change(body);assert.equal(first.statusCode,200);assert.deepEqual(repeat.json(),first.json());assert.equal(service.store.conversation(a.json().id).version,2);assert.equal((await change({...body,expected_version:2})).statusCode,409);
 const legacy=await service.app.inject({method:'POST',url:'/api/conversations',headers,payload:{}});assert.equal(legacy.json().mode,'work');assert.equal(service.store.conversations().length,2);
 }finally{await service.close();}
});
