import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Store} from '../src/store.mjs';
import {Agent} from '../src/agent.mjs';
import {buildServer} from '../src/server.mjs';
const impl=await import('../src/chat-policy.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('Chat configuration is explicit, thinking-disabled, stable and contains no transport credentials',()=>{
 assert.equal(typeof impl.chatRoute,'function');assert.equal(impl.chatRoute(),undefined);
 assert.throws(()=>impl.chatRoute({enabled:true,baseUrl:'https://model.example/v1',model:'fast'}),/chat_configuration/);
 const config={enabled:true,baseUrl:'https://model.example/v1/',model:'fast',thinkingDisabledSupported:true,key:'fixture'};
 const a=impl.chatRoute(config),b=impl.chatRoute({...config,key:'rotated-fixture'});assert.deepEqual(a.policy,b.policy);assert.equal(a.policy.thinking,'disabled');assert.doesNotMatch(JSON.stringify(a.policy),/model\.example|fixture/);assert.ok(Object.isFrozen(a.policy));
 const rejected=new URL('https://example.test/v1');rejected.username='test-user';rejected.password='test-password';assert.throws(()=>impl.chatRoute({...config,baseUrl:rejected.href}),/chat_configuration/);
});

test('accepted Chat freezes an ordered bounded text seed without changing stored history',async()=>{
 assert.equal(typeof impl.chatRoute,'function');const store=new Store(':memory:');
 try{
  const c=store.createConversation('test','chat');for(let i=0;i<25;i++)store.message(c.id,i%2?'assistant':'user',String(i)+':'+(i%2?'A':'U').repeat(5000));
  store.message(c.id,'tool','RAW-TOOL-MUST-NOT-SEED');const route=impl.chatRoute({enabled:true,baseUrl:'https://model.example/v1',model:'fast',thinkingDisabledSupported:true});
  const {run}=store.accept(c.id,'CURRENT INPUT','one',{chatReady:true,chatPolicy:route.policy});const execution=store.chatExecution(run.id);assert.deepEqual(execution.policy,route.policy);assert.ok(execution.seed.messages.length<=12);assert.ok(execution.seed.messages.reduce((n,m)=>n+m.text.length,0)<=14000);assert.equal(execution.seed.messages.at(-1).text,'CURRENT INPUT');assert.ok(execution.seed.messages.every(m=>m.message_id&&['user','assistant'].includes(m.role)));assert.doesNotMatch(JSON.stringify(execution.seed),/RAW-TOOL/);assert.equal(store.messages(c.id).length,27);
  const before=JSON.stringify(execution);store.message(c.id,'assistant','LATE NOT IN SEED');assert.equal(JSON.stringify(store.chatExecution(run.id)),before);assert.equal(store.accept(c.id,'CURRENT INPUT','one').run.id,run.id);assert.equal(store.chatExecution(run.id).seed.messages.at(-1).text,'CURRENT INPUT');
 }finally{store.close();}
});

test('Chat makes one parallel group per Web kind, caches exact calls and never executes writes',async()=>{
 assert.equal(typeof impl.chatRoute,'function');const store=new Store(':memory:');let step=0,active=0,peak=0;const effects=[],requests=[];
 const base=impl.chatRoute({enabled:true,baseUrl:'https://model.example/v1',model:'fast',thinkingDisabledSupported:true});
 const search=tool('s1','search',{query:'first'}),sameUrl=tool('f1','read_page',{url:'https://example.com/a'});
 const route={policy:base.policy,provider:async(history,definitions)=>{
  requests.push({history:structuredClone(history),names:definitions.map(d=>d.function.name)});step++;
  if(step===1)return{role:'assistant',content:null,tool_calls:[search,tool('s2','search',{query:'second'}),tool('w1','file_write',{name:'bad.md',text:'no'})]};
  if(step===2)return{role:'assistant',content:null,tool_calls:[search,tool('s3','search',{query:'not again'}),sameUrl,tool('f2','read_page',{url:'https://example.com/a#repeat'})]};
  if(step===3)return{role:'assistant',content:null,tool_calls:[tool('f3','read_page',{url:'https://example.com/b'}),tool('s1','file_read',{artifact_id:'changed-call'})]};
  return{role:'assistant',content:'Verified summary'};
 }};
 const agent=new Agent(store,{provider:async()=>{throw Error('Work route forbidden');},chatRoute:route,tools:{definitions:['search','read_page','file_read','file_write','browser_action'].map(name=>({type:'function',function:{name}})),execute:async(name,args)=>{effects.push({name,args});active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;return{verified:true};}}});
 try{
  const {run}=store.accept(store.createConversation('test','chat').id,'find facts','one',{chatReady:true,chatPolicy:route.policy});await agent.execute(run);assert.equal(store.run(run.id).status,'succeeded');assert.deepEqual(effects.map(e=>e.name),['search','search','read_page']);assert.equal(peak,2);assert.ok(requests.every(r=>r.names.every(n=>['search','read_page','file_read'].includes(n))));assert.match(JSON.stringify(requests.at(-1).history),/tool_allowance_exhausted/);assert.match(JSON.stringify(requests.at(-1).history),/tool_url_already_read/);assert.equal(store.messages(run.conversation_id).filter(m=>m.role==='assistant').length,1);
 }finally{await agent.close();store.close();}
});

test('reserved Web group survives disk reopen and cannot dispatch an unknown effect again',async()=>{
 assert.equal(typeof impl.chatRoute,'function');const scratch=resolve(tmpdir()),root=await mkdtemp(join(scratch,'jot-chat-ledger-'));let store;
 try{
  store=new Store(join(root,'db.sqlite'));const route=impl.chatRoute({enabled:true,baseUrl:'https://model.example/v1',model:'fast',thinkingDisabledSupported:true}),{run}=store.accept(store.createConversation('test','chat').id,'read','one',{chatReady:true,chatPolicy:route.policy});store.state(run.id,'running');
  const calls=[tool('read-original','read_page',{url:'https://example.com/a'})];const first=store.reserveChatGroup(run.id,'fetch',calls);assert.equal(first[0].dispatch,true);store.close();store=new Store(join(root,'db.sqlite'));
  const retry=store.reserveChatGroup(run.id,'fetch',calls);assert.equal(retry[0].dispatch,false);assert.equal(retry[0].result.error,'tool_outcome_unknown');assert.equal(store.reserveChatGroup(run.id,'fetch',[tool('new','read_page',{url:'https://example.com/b'})])[0].result.error,'tool_allowance_exhausted');assert.equal(store.chatExecution(run.id).seed.messages.at(-1).text,'read');
 }finally{store?.close();assert.ok(root.startsWith(scratch+sep));await rm(root,{recursive:true,force:true});}
});

test('Chat bounds model-visible tool bodies while retaining complete stored tool receipts',async()=>{
 assert.equal(typeof impl.chatRoute,'function');const store=new Store(':memory:');let step=0,lastHistory;
 const base=impl.chatRoute({enabled:true,baseUrl:'https://model.example/v1',model:'fast',thinkingDisabledSupported:true}),route={policy:base.policy,provider:async history=>{lastHistory=structuredClone(history);return ++step===1?{role:'assistant',content:null,tool_calls:Array.from({length:8},(_,i)=>tool('s'+i,'search',{query:'q'+i}))}:{role:'assistant',content:'summary'};}};
 const agent=new Agent(store,{chatRoute:route,tools:{definitions:[{type:'function',function:{name:'search'}}],execute:async()=>({text:'evidence '.repeat(5000),untrusted:true})}});
 try{const {run}=store.accept(store.createConversation('test','chat').id,'search','one',{chatReady:true,chatPolicy:route.policy});await agent.execute(run);assert.equal(store.run(run.id).status,'succeeded');const visible=lastHistory.filter(m=>m.role==='tool');assert.ok(visible.reduce((n,m)=>n+m.content.length,0)<=24000);assert.ok(visible.some(m=>m.content.includes('truncated')));assert.ok(store.db.prepare('SELECT result FROM chat_web_calls WHERE run_id=? LIMIT 1').get(run.id).result.length>30000);}
 finally{await agent.close();store.close();}
});

test('Chat cancellation records an unsettled model outcome without an answer or Work fallback',async()=>{
 assert.equal(typeof impl.chatRoute,'function');const store=new Store(':memory:');let started;const entered=new Promise(r=>started=r);
 const base=impl.chatRoute({enabled:true,baseUrl:'https://model.example/v1',model:'fast',thinkingDisabledSupported:true}),route={policy:base.policy,provider:async(history,defs,signal,onText)=>{onText('partial');started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}};
 const agent=new Agent(store,{chatRoute:route,provider:async()=>{throw Error('Work fallback forbidden');},tools:{definitions:[]}});
 try{const {run}=store.accept(store.createConversation('test','chat').id,'slow','one',{chatReady:true,chatPolicy:route.policy});const pending=agent.execute(run);await entered;agent.cancel(run.id);await pending;assert.equal(store.run(run.id).status,'cancelled');assert.equal(store.messages(run.conversation_id).filter(m=>m.role==='assistant').length,0);assert.deepEqual(store.chatModelCalls(run.id),[{step:0,status:'cancelled',usage:null}]);}
 finally{await agent.close();store.close();}
});

test('a changed Chat route cannot consume an accepted policy',async()=>{
 assert.equal(typeof impl.chatRoute,'function');const store=new Store(':memory:');let calls=0;
 const a=impl.chatRoute({enabled:true,baseUrl:'https://model.example/v1',model:'first',thinkingDisabledSupported:true}),b=impl.chatRoute({enabled:true,baseUrl:'https://model.example/v1',model:'second',thinkingDisabledSupported:true});
 const agent=new Agent(store,{chatRoute:{policy:b.policy,provider:async()=>{calls++;return{role:'assistant',content:'wrong'};}},tools:{definitions:[]}});
 try{const {run}=store.accept(store.createConversation('test','chat').id,'question','one',{chatReady:true,chatPolicy:a.policy});await agent.execute(run);assert.equal(calls,0);assert.equal(store.run(run.id).error,'model_chat_unavailable');assert.equal(store.chatModelCalls(run.id).length,0);}
 finally{await agent.close();store.close();}
});

test('oversized intermediate model context fails before tools or a second model request',async()=>{
 assert.equal(typeof impl.chatRoute,'function');const store=new Store(':memory:');let calls=0,effects=0;
 const base=impl.chatRoute({enabled:true,baseUrl:'https://model.example/v1',model:'fast',thinkingDisabledSupported:true}),route={policy:base.policy,provider:async()=>++calls===1?{role:'assistant',content:null,tool_calls:[tool('large','file_read',{artifact_id:'x'.repeat(33000)})]}:{role:'assistant',content:'should not happen'}};
 const agent=new Agent(store,{chatRoute:route,tools:{definitions:[{type:'function',function:{name:'file_read'}}],execute:async()=>{effects++;return{};}}});
 try{const {run}=store.accept(store.createConversation('test','chat').id,'question','one',{chatReady:true,chatPolicy:route.policy});await agent.execute(run);assert.equal(store.run(run.id).error,'model_context_too_large');assert.equal(calls,1);assert.equal(effects,0);assert.equal(store.messages(run.conversation_id).filter(m=>m.role==='assistant').length,0);}
 finally{await agent.close();store.close();}
});

test('invalid or missing usage stays unknown instead of becoming zero tokens',()=>{
 assert.equal(impl.modelUsage(null),null);assert.equal(impl.modelUsage({prompt_tokens:1,completion_tokens:1,total_tokens:0}),null);assert.equal(impl.modelUsage({prompt_tokens:2,completion_tokens:1,total_tokens:3,prompt_cache_hit_tokens:9}),null);assert.deepEqual(impl.modelUsage({prompt_tokens:2,completion_tokens:1,total_tokens:3}),{prompt_tokens:2,completion_tokens:1,total_tokens:3});
});

test('actual local streaming Chat request uses its frozen route, off policy, stable prefix and committed answer',async()=>{
 assert.equal(typeof impl.chatRoute,'function');const requests=[];let workCalls=0,service;const scratch=resolve(tmpdir()),root=await mkdtemp(join(scratch,'jot-chat-stream-')),database=join(root,'db.sqlite');
 const model=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push(JSON.parse(Buffer.concat(chunks)));res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'Local streamed answer'},finish_reason:'stop'}],usage:{prompt_tokens:24,completion_tokens:4,total_tokens:28,prompt_cache_hit_tokens:12}})+'\n\n');res.end('data: [DONE]\n\n');});
 await new Promise(r=>model.listen(0,'127.0.0.1',r));
 try{
  service=await buildServer({database,provider:async()=>{workCalls++;throw Error('wrong Work model');},chat:{enabled:true,baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',model:'fixture-fast',thinkingDisabledSupported:true}});
  const caps=(await service.app.inject({url:'/api/capabilities'})).json(),headers={'x-jot-token':caps.csrf};assert.equal(caps.conversation_modes.chat.ready,true);assert.equal(caps.conversation_modes.default,'chat');
  const c=(await service.app.inject({method:'POST',url:'/api/conversations',headers,payload:{mode:'chat'}})).json();
  for(let i=0;i<2;i++){const accepted=await service.app.inject({method:'POST',url:'/api/conversations/'+c.id+'/messages',headers,payload:{text:'question '+i,request_id:'question-'+i}});assert.equal(accepted.statusCode,202);await service.agent.jobs.get(accepted.json().run.id)?.promise;assert.equal(service.store.run(accepted.json().run.id).status,'succeeded');}
  assert.equal(workCalls,0);assert.equal(requests.length,2);assert.equal(requests[0].model,'fixture-fast');assert.deepEqual(requests[0].thinking,{type:'disabled'});assert.equal(requests[0].messages[0].content,requests[1].messages[0].content);assert.equal(requests[0].reasoning_effort,undefined);assert.equal(service.store.messages(c.id).filter(m=>m.role==='assistant').length,2);
  const events=service.store.events(c.id,0);assert.ok(events.some(e=>e.type==='assistant.delta'));const usage=service.store.chatModelCalls(service.store.runs(c.id)[0].id);assert.equal(usage.length,1);assert.equal(usage[0].status,'complete');assert.equal(usage[0].usage.prompt_cache_hit_tokens,12);assert.equal(usage[0].usage.total_tokens,28);
  const original=service.store.runs(c.id)[0];await service.close();service=await buildServer({database,chat:{enabled:false},provider:async()=>{workCalls++;throw Error('must not replay');}});const restoredHeaders={'x-jot-token':(await service.app.inject({url:'/api/capabilities'})).json().csrf};
  const duplicate=await service.app.inject({method:'POST',url:'/api/conversations/'+c.id+'/messages',headers:restoredHeaders,payload:{text:'question 0',request_id:'question-0'}});assert.equal(duplicate.statusCode,202);assert.equal(duplicate.json().run.id,original.id);assert.equal(duplicate.json().duplicate,true);assert.equal(service.store.chatModelCalls(original.id).length,1);assert.equal(service.store.runs(c.id).length,2);assert.equal(workCalls,0);assert.equal(requests.length,2);
 }finally{await service?.close();model.closeAllConnections();await new Promise(r=>model.close(r));assert.ok(root.startsWith(scratch+sep));await rm(root,{recursive:true,force:true});}
});
