import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelBudgetLedger} from '../../gateway/src/workbench/model-budget.ts';
import {openProductDatabase} from '../../gateway/src/db/database.ts';
import {ConversationRepository} from '../../gateway/src/conversations/repository.ts';
import {RunRepository} from '../../gateway/src/runs/repository.ts';
import {EventStore} from '../../gateway/src/events/event-store.ts';

const moduleUrl=new URL('../model-budget-stream.js',import.meta.url);
const usage={inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40};
const chunks=[{type:'text-delta',index:0,text:'Controlled response'},{type:'usage',usage},{type:'finish',reason:{kind:'stop'}}];
async function fixture(limits={tokens:1000,nano_usd:10000,model_calls:10}){
 const mod=await import(moduleUrl.href).catch(()=>({}));assert.equal(typeof mod.budgetedModelStream,'function','host stream budget interceptor must exist');
 const db=openProductDatabase(':memory:');const ledger=new ModelBudgetLedger(db,{routes:[{provider:'fixture',model:'bounded',revision:'fixture-v1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}}]});
 const conversation=new ConversationRepository(db).create('alice',{workspace_id:'main',model:{provider:'fixture',id:'bounded'}});
 const run=new RunRepository(db,new EventStore(db)).enqueue(conversation.conversation_id,'alice',{client_message_id:'controlled-task',content:[{type:'text',text:'Controlled source'}]});
 db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 const scope=ledger.createScope('alice','controlled-root',limits);ledger.bindRun('alice',run.run_id,[scope.scope_id]);
 const binding=Object.freeze({runId:run.run_id,sessionRef:'fixture-session'}),requests=[];let providerCalls=0,guardCalls=0;
 let failAction,failAfterCommit=false,guardFailureAt,abortAtProvider=false;
 const request=async(path,received,payload,signal)=>{
  assert.equal(path,'model-budget');assert.equal(received,binding);assert.equal(signal,undefined,'settlement is independent of a cancelled model signal');
  assert.equal(payload.owner_id,undefined);assert.equal(payload.scope_id,undefined);requests.push(structuredClone(payload));
  if(failAction===payload.action&&!failAfterCommit)throw new Error('controlled transport unavailable');
  let receipt;
  if(payload.action==='reserve')receipt=ledger.reserve('alice',run.run_id,payload.request);
  else if(payload.action==='dispatch')receipt=ledger.dispatch('alice',run.run_id,payload.attempt_id);
  else if(payload.action==='settle')receipt=ledger.settle('alice',run.run_id,payload.attempt_id,payload.usage);
  else if(payload.action==='unknown')receipt=ledger.markUnknown('alice',run.run_id,payload.attempt_id,payload.reason);
  else if(payload.action==='release')receipt=ledger.releaseUndispatched('alice',run.run_id,payload.attempt_id);
  else throw new Error('unknown action');
  if(failAction===payload.action&&failAfterCommit)throw new Error('controlled lost response');
  return {receipt};
 };
 const controller=new AbortController();
 const options=Object.freeze({provider:'fixture',model:'bounded',sessionId:binding.sessionRef,maxTokens:20,messages:Object.freeze([]),signal:controller.signal});
 const stream=(values=chunks,overrides={})=>mod.budgetedModelStream({binding,options:Object.freeze({...options,...overrides}),request,
  check:async()=>{guardCalls++;if(guardCalls===guardFailureAt)throw new Error('controlled binding revoked');},
  next:()=>{providerCalls++;if(abortAtProvider)controller.abort();return (async function*(){for(const chunk of values){if(chunk instanceof Error)throw chunk;yield chunk;}})();}});
 return {db,ledger,scope,binding,requests,options,stream,controller,balance:()=>ledger.balance('alice',scope.scope_id),providerCalls:()=>providerCalls,
  fail(action,afterCommit=false){failAction=action;failAfterCommit=afterCommit;},guardFailAt(n){guardFailureAt=n;},abortAtProvider(){abortAtProvider=true;},close(){db.close();}};
}
async function collect(iterable){const out=[];for await(const value of iterable)out.push(value);return out;}

test('native chunks stay intact and terminal finish cannot precede durable exact settlement',async()=>{
 const f=await fixture();try{
  const out=[];for await(const c of f.stream()){if(c.type==='finish')assert.equal(f.balance().used.tokens,'40');out.push(c);}
  assert.deepEqual(out,chunks);assert.equal(f.providerCalls(),1);assert.equal(f.balance().used.nano_usd,'115');
  assert.deepEqual(f.requests.map(x=>x.action),['reserve','dispatch','settle']);
  assert.equal(f.options.maxTokens,20);assert.ok(Object.isFrozen(f.options));assert.equal(f.balance().held.tokens,'0');
 }finally{f.close();}
});

test('admission refusal never invokes the provider and a failed post-reservation guard releases only undispatched capacity',async()=>{
 const f=await fixture({tokens:99,nano_usd:10000,model_calls:10});try{
  await assert.rejects(collect(f.stream()),/model_budget_exhausted/);assert.equal(f.providerCalls(),0);assert.equal(f.balance().held.tokens,'0');
 }finally{f.close();}
 const g=await fixture();try{
  g.guardFailAt(2);await assert.rejects(collect(g.stream()),/controlled binding revoked/);
  assert.equal(g.providerCalls(),0);assert.equal(g.balance().held.tokens,'0');assert.equal(g.balance().used.model_calls,'0');
  assert.deepEqual(g.requests.map(x=>x.action),['reserve','release']);
 }finally{g.close();}
});

test('consumer cancellation closes the provider and retains unknown spend instead of refunding a started call',async()=>{
 const f=await fixture();try{
  const iterator=f.stream()[Symbol.asyncIterator]();assert.equal((await iterator.next()).value.type,'text-delta');await iterator.return();
  assert.equal(f.balance().held.tokens,'100');assert.equal(f.balance().used.tokens,'0');
  assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'unknown');
  await assert.rejects(collect(f.stream()),/budget_usage_unknown/);assert.equal(f.providerCalls(),1);
 }finally{f.close();}
});

test('missing usage, missing finish and data after finish never masquerade as successful zero-cost calls',async()=>{
 for(const values of [[chunks[0],chunks[2]],[chunks[0],chunks[1]],[...chunks,{type:'text-delta',index:0,text:'late data'}]]){
  const f=await fixture();try{
   const output=[];await assert.rejects((async()=>{for await(const c of f.stream(values))output.push(c);})(),/workbench_budget_stream_incomplete|workbench_budget_usage_unknown/);
   assert.equal(output.some(c=>c.type==='finish'),false);assert.equal(f.balance().held.tokens,'100');assert.equal(f.balance().used.tokens,'0');
  }finally{f.close();}
 }
});

test('provider errors preserve their cause and a reported error finish still charges actual usage',async()=>{
 const f=await fixture();try{
  await assert.rejects(collect(f.stream([chunks[0],new Error('controlled provider failure')])),/controlled provider failure/);
  assert.equal(f.balance().held.tokens,'100');
 }finally{f.close();}
 const g=await fixture();try{
  assert.equal((await collect(g.stream([chunks[0],chunks[1],{type:'finish',reason:{kind:'error',failure:{code:'UNKNOWN',message:'Controlled provider failure'}}}]))).at(-1).reason.kind,'error');
  assert.equal(g.balance().used.tokens,'40');assert.equal(g.balance().held.tokens,'0');
 }finally{g.close();}
});

test('lost dispatch acknowledgement cannot replay the provider or free a possibly started reservation',async()=>{
 const f=await fixture();try{
  f.fail('dispatch',true);await assert.rejects(collect(f.stream()),/controlled lost response/);
  assert.equal(f.providerCalls(),0);assert.equal(f.balance().held.tokens,'100');
  assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'unknown');
 }finally{f.close();}
});

test('lost settlement acknowledgements block success; committed usage is not replaced by unknown or double charged',async()=>{
 for(const afterCommit of [false,true]){
  const f=await fixture();try{
   f.fail('settle',afterCommit);const output=[];
   await assert.rejects((async()=>{for await(const c of f.stream())output.push(c);})(),/controlled transport unavailable|controlled lost response/);
   assert.equal(output.some(c=>c.type==='finish'),false);
   assert.equal(f.balance().used.tokens,afterCommit?'40':'0');assert.equal(f.balance().held.tokens,afterCommit?'0':'100');
   assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,afterCommit?'settled':'unknown');
  }finally{f.close();}
 }
});

test('retries and compaction have distinct attempts; only the final provider usage sample settles',async()=>{
 const f=await fixture();try{
  await collect(f.stream([{type:'usage',usage:{inputTokens:1,outputTokens:0,totalTokens:1}},...chunks]));
  await collect(f.stream(chunks,{purpose:'compaction'}));
  const attempts=f.requests.filter(x=>x.action==='reserve').map(x=>x.request.attempt_id);
  assert.equal(new Set(attempts).size,2);assert.equal(f.requests.filter(x=>x.action==='reserve')[1].request.purpose,'compaction');
  assert.equal(f.balance().used.model_calls,'2');assert.equal(f.balance().used.tokens,'80');
 }finally{f.close();}
});

test('a cancelled model signal cannot prevent settlement and mismatched Session calls cannot bypass accounting',async()=>{
 const f=await fixture();try{
  f.abortAtProvider();await collect(f.stream());assert.equal(f.balance().used.tokens,'40');assert.equal(f.balance().held.tokens,'0');
 }finally{f.close();}
 const g=await fixture();try{
  await assert.rejects(collect(g.stream(chunks,{sessionId:'another-session'})),/workbench_budget_session_mismatch/);
  assert.equal(g.providerCalls(),0);assert.equal(g.requests.length,0);
  g.controller.abort();await assert.rejects(collect(g.stream()),/abort/i);assert.equal(g.requests.length,0);
 }finally{g.close();}
});
