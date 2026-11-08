import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {WorkbenchBridge} from '../../../session-adapter/workbench.js';
import {rankMemory,rankMemoryDetailed} from '../../src/workbench/memory-lifecycle.ts';
const values=[{memory_id:'a',version:1,content:'Park lake',verified:false},{memory_id:'b',version:2,content:'Park',verified:true},{memory_id:'c',version:1,content:'Museum',verified:false}];
test('retrieval explanations preserve existing stable substring ranking without claiming model confidence',()=>{
 const ranked=rankMemoryDetailed(values,'park lake');assert.deepEqual(ranked.items.map(x=>x.memory_id),['a','b']);assert.deepEqual(ranked.items,rankMemory(values,'park lake'));
 assert.equal(ranked.method,'keyword');assert.equal(ranked.references[0].keyword_score,2);assert.deepEqual(ranked.references[0].matched_terms,['park','lake']);assert.equal(ranked.references[1].keyword_score,1);assert.equal(Object.hasOwn(ranked.references[0],'confidence'),false);
 const empty=rankMemoryDetailed(values,'');assert.deepEqual(empty.items,values);assert.equal(empty.method,'scope_order');assert.equal(empty.references.every(x=>x.keyword_score===null),true);
});
test('adapter order and appended scope tail are distinguished and invalid adapters fall back without leaking errors',()=>{
 let calls=0;const ranked=rankMemoryDetailed(values,'park',{rank(input){calls++;input.candidates[0].content='Mutated';return ['b'];}});
 assert.equal(calls,1);assert.deepEqual(ranked.items.map(x=>x.memory_id),['b','a','c']);assert.equal(values[0].content,'Park lake');assert.equal(ranked.references[0].reason,'adapter_rank');assert.equal(ranked.references[1].reason,'adapter_tail');assert.equal(ranked.references.every(x=>x.keyword_score===null),true);
 for(const adapter of [{rank(){return ['foreign'];}},{rank(){return ['a','a'];}},{rank(){throw new Error('sensitive provider detail');}}]){
  const result=rankMemoryDetailed(values,'park',adapter);assert.equal(result.method,'keyword');assert.deepEqual(result.items.map(x=>x.memory_id),['a','b']);assert.ok(['invalid_adapter_result','adapter_failed'].includes(result.fallback_reason));assert.doesNotMatch(JSON.stringify(result),/sensitive provider detail/);
 }
});
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openProductDatabase,withImmediateTransaction} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {registerWorkbenchExecution} from '../../src/workbench/execution.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
function fixture(t){
 const base=resolve('.test-tmp/memory-retrievals');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(root,'db.sqlite')),options={workspaceIds:['ws','other'],root:join(root,'files')},service=new WorkbenchService(db,options),agent=service.createAgent('alice',{name:'Reader'});
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const save=input=>service.saveMemory('alice','ws',{scope:'private',agent_id:agent.agent_id,content:'Park lake source',...input});
 const run=()=>service.enqueueAgentMessage('alice',agent.agent_id,{text:'Read my notes',client_message_id:crypto.randomUUID()});
 return {db,root,options,service,agent,save,run};
}
test('a frozen context trace explains actual bounded selection while management reads and guards write nothing',t=>{
 const f=fixture(t),first=f.save({content:'Park lake '+ 'x'.repeat(4000),verified:true,provenance:[{kind:'document',reference:'source.md'}]});f.save({content:first.content});
 const leading=f.service.listMemory('alice','ws',{agent_id:f.agent.agent_id}).items[0],run=f.run(),log=f.service.memoryRetrievals,page=log.list('alice','ws',f.agent.agent_id);assert.equal(page.items.length,1);assert.equal(page.items[0].kind,'context_snapshot');
 const trace=log.get('alice','ws',page.items[0].retrieval_id);assert.equal(trace.method,'scope_order');assert.equal(trace.result_count,1);assert.equal(trace.excluded.duplicate,1);assert.equal(trace.references[0].memory_id,leading.memory_id);assert.equal(trace.references[0].truncated,true);assert.equal(trace.references[0].available,true);assert.equal(trace.references[0].content_preview.length,800);assert.equal(trace.references[0].keyword_score,null);assert.ok(trace.context_chars<=12000);
 const count=f.db.prepare('SELECT count(*) n FROM wb_memory_retrievals').get().n;for(let i=0;i<3;i++){f.service.contextForRun(run.run_id);f.service.listMemory('alice','ws',{agent_id:f.agent.agent_id});log.get('alice','ws',trace.retrieval_id);}
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_retrievals').get().n,count);assert.doesNotMatch(JSON.stringify(trace),/owner_id|session_ref|context_json|confidence/);
});
test('explicit retrieval tracks each actual observation and never revives corrected or deleted source text',t=>{
 const f=fixture(t),note=f.save({}),run=f.run();
 const a=f.service.retrieveMemory('alice','ws',{q:'park lake'},run.run_id,'query-once'),b=f.service.retrieveMemory('alice','ws',{q:'park lake'},run.run_id,'query-once');assert.equal(a.retrieval_id,b.retrieval_id);assert.equal(a.items.length,1);
 const log=f.service.memoryRetrievals,trace=log.get('alice','ws',a.retrieval_id);assert.equal(trace.kind,'tool_query');assert.equal(trace.references[0].keyword_score,2);
 f.save({memory_id:note.memory_id,expected_version:1,content:'Park corrected conclusion'});
 const old=log.get('alice','ws',a.retrieval_id);assert.equal(old.references[0].available,false);assert.equal(Object.hasOwn(old.references[0],'content_preview'),false);assert.equal(Object.hasOwn(old.references[0],'provenance'),false);
 const changed=f.service.retrieveMemory('alice','ws',{q:'park lake'},run.run_id,'query-once');assert.notEqual(changed.retrieval_id,a.retrieval_id);assert.equal(changed.items[0].version,2);
 f.service.deleteMemory('alice','ws',note.memory_id,2);assert.equal(log.get('alice','ws',changed.retrieval_id).references[0].available,false);assert.doesNotMatch(JSON.stringify(log.get('alice','ws',changed.retrieval_id)),/corrected conclusion/);
});
test('trace paging is owner and role scoped with opaque cursors and immutable records',t=>{
 const f=fixture(t),note=f.save({}),run=f.run(),log=f.service.memoryRetrievals;
 for(let i=0;i<26;i++)f.service.retrieveMemory('alice','ws',{q:'park'},run.run_id,'query-'+i);
 const first=log.list('alice','ws',f.agent.agent_id);assert.equal(first.items.length,25);assert.equal(typeof first.next_before_id,'string');assert.equal(Object.hasOwn(first.items[0],'sequence'),false);
 const second=log.list('alice','ws',f.agent.agent_id,first.next_before_id);assert.equal(second.items.length,2);assert.equal(second.next_before_id,null);assert.equal(new Set([...first.items,...second.items].map(x=>x.retrieval_id)).size,27);
 assert.throws(()=>log.get('bob','ws',first.items[0].retrieval_id),/memory_retrieval_not_found/);assert.throws(()=>log.get('alice','other',first.items[0].retrieval_id),/memory_retrieval_not_found/);
 const other=f.service.createAgent('alice',{name:'Other reader',project_id:f.agent.project_id}),otherRun=f.service.enqueueAgentMessage('alice',other.agent_id,{text:'Own notes',client_message_id:'other'}),cursor=log.list('alice','ws',other.agent_id).items[0].retrieval_id;
 assert.throws(()=>log.list('alice','ws',f.agent.agent_id,cursor),/memory_retrieval_not_found/);
 const id=first.items[0].retrieval_id;for(const sql of ["UPDATE wb_memory_retrievals SET query='forged' WHERE retrieval_id=?",'DELETE FROM wb_memory_retrievals WHERE retrieval_id=?','INSERT OR REPLACE INTO wb_memory_retrievals SELECT * FROM wb_memory_retrievals WHERE retrieval_id=?'])assert.throws(()=>f.db.prepare(sql).run(id),/memory_retrieval_immutable/);
 const persisted=f.db.prepare('SELECT * FROM wb_memory_retrievals WHERE retrieval_id=?').get(id);assert.doesNotMatch(JSON.stringify(persisted),/Park lake source|source.md/);assert.equal(f.service.contextForRun(otherRun.run_id).memories.some(x=>x.memory_id===note.memory_id),false);
});
test('failed trace persistence rolls back binding and expired data is not returned through old traces',t=>{
 const f=fixture(t),note=f.save({expires_at:'2099-01-01T00:00:00Z'}),before=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;
 f.db.exec("CREATE TRIGGER fail_trace BEFORE INSERT ON wb_memory_retrievals BEGIN SELECT RAISE(ABORT,'synthetic_trace_failure'); END;");assert.throws(()=>f.run(),/synthetic_trace_failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before);f.db.exec('DROP TRIGGER fail_trace');
 f.run();const log=f.service.memoryRetrievals,id=log.list('alice','ws',f.agent.agent_id).items[0].retrieval_id;
 f.db.prepare('UPDATE wb_memories SET expires_at=? WHERE memory_id=?').run('2000-01-01T00:00:00.000Z',note.memory_id);assert.equal(log.get('alice','ws',id).references[0].available,false);
});

test('retrieval references survive SQLite reopening without restoring an old source body',t=>{
 const base=resolve('.test-tmp/memory-retrieval-restart');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),path=join(root,'db.sqlite'),options={workspaceIds:['ws'],root:join(root,'files')};let db=openProductDatabase(path);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});let service=new WorkbenchService(db,options);const agent=service.createAgent('alice',{name:'Persistent reader'}),note=service.saveMemory('alice','ws',{scope:'private',agent_id:agent.agent_id,content:'Park before restart'}),run=service.enqueueAgentMessage('alice',agent.agent_id,{text:'Find park',client_message_id:'restart'}),id=service.retrieveMemory('alice','ws',{q:'park'},run.run_id,'query').retrieval_id;
 db.close();db=openProductDatabase(path);service=new WorkbenchService(db,options);assert.equal(service.memoryRetrievals.get('alice','ws',id).references[0].content_preview,'Park before restart');
 service.deleteMemory('alice','ws',note.memory_id,1);db.close();db=openProductDatabase(path);service=new WorkbenchService(db,options);const trace=service.memoryRetrievals.get('alice','ws',id);assert.equal(trace.references[0].available,false);assert.equal(Object.hasOwn(trace.references[0],'content_preview'),false);assert.equal(service.memoryRetrievals.list('alice','ws',agent.agent_id).items.length,2);
});

test('context delivery persists an immutable receipt bound to the exact selected retrieval trace',t=>{
 const f=fixture(t),note=f.save({content:'Context receipt secret'}),run=f.run(),context=f.service.contextForRun(run.run_id);
 const trace=f.service.memoryRetrievals.list('alice','ws',f.agent.agent_id).items.find(item=>item.run_id===run.run_id&&item.kind==='context_snapshot');
 assert.equal(context.memory_retrieval_id,trace.retrieval_id);
 const references=context.memories.map(({memory_id,version})=>({memory_id,version})),contextHash=createHash('sha256').update(JSON.stringify(context.memories)).digest('hex');
 const receipt=withImmediateTransaction(f.db,()=>f.service.recordContextDelivery('alice','ws',run.run_id,trace.retrieval_id,contextHash,references));
 assert.equal(receipt.status,'delivered_to_session');assert.equal(receipt.source_retrieval_id,trace.retrieval_id);assert.equal(receipt.context_hash,contextHash);assert.equal(receipt.reference_count,1);
 const log=f.service.memoryRetrievals,detail=log.get('alice','ws',receipt.retrieval_id);
 assert.equal(detail.context_delivery.status,'delivered_to_session');assert.equal(detail.context_delivery.source_retrieval_id,trace.retrieval_id);assert.equal(detail.references[0].memory_id,note.memory_id);assert.equal(detail.references[0].version,1);
 assert.equal(withImmediateTransaction(f.db,()=>f.service.recordContextDelivery('alice','ws',run.run_id,trace.retrieval_id,contextHash,references)).retrieval_id,receipt.retrieval_id);
 const stored=f.db.prepare('SELECT data_json FROM wb_memory_retrievals WHERE retrieval_id=?').get(receipt.retrieval_id);assert.doesNotMatch(JSON.stringify(stored),/Context receipt secret|session_ref/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>f.service.recordContextDelivery('alice','ws',run.run_id,trace.retrieval_id,'0'.repeat(64),references)),/memory_context_delivery_mismatch/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>f.service.recordContextDelivery('alice','ws',run.run_id,trace.retrieval_id,contextHash,[])),/memory_context_delivery_mismatch/);
 f.save({memory_id:note.memory_id,expected_version:1,content:'Corrected source'});
 const invalidated=log.get('alice','ws',receipt.retrieval_id);assert.equal(invalidated.references[0].available,false);assert.equal(Object.hasOwn(invalidated.references[0],'content_preview'),false);
});

test('the registered context-delivery route accepts the real Bridge payload and rejects identity/hash/reference mismatches',async t=>{
 const f=fixture(t),note=f.save({content:'Context receipt secret'}),run=f.run(),context=f.service.contextForRun(run.run_id),sessionRef=new SessionBindingRepository(f.db).getOrCreate('alice',run.conversation_id).session_id;
 const app=Fastify(),token='context-delivery-route-token';t.after(()=>app.close());
 registerWorkbenchExecution(app,f.db,f.service,{assertRunActive(){}},token);
 const requests=[];
 const fetchImpl=async(url,init)=>{const path=new URL(url).pathname,body=JSON.parse(init.body);requests.push({path,body});const response=await app.inject({method:init.method,url:path,headers:init.headers,payload:init.body});return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1',token,fetchImpl}),binding={runId:run.run_id,sessionRef},references=context.memories.map(({memory_id,version})=>({memory_id,version}));
 const payload={memory_retrieval_id:context.memory_retrieval_id,context_hash:createHash('sha256').update(JSON.stringify(context.memories)).digest('hex'),references};
 const delivered=await bridge.request('context-delivery',binding,payload);
 assert.equal(delivered.receipt.status,'delivered_to_session');assert.equal(delivered.receipt.source_retrieval_id,context.memory_retrieval_id);assert.equal(delivered.receipt.reference_count,1);
 const request=requests.find(value=>value.path==='/internal/v1/workbench/context-delivery');
 assert.deepEqual(request.body,{...payload,run_id:binding.runId,session_ref:binding.sessionRef});
 assert.equal((await bridge.request('context-delivery',binding,payload)).receipt.retrieval_id,delivered.receipt.retrieval_id);
 const wire={...request.body};
 for(const invalid of [{...wire,run_id:'wrong-run'},{...wire,session_ref:'wrong-session'},{...wire,context_hash:'0'.repeat(64)},{...wire,references:[]}]){
  const response=await app.inject({method:'POST',url:'/internal/v1/workbench/context-delivery',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},payload:invalid});assert.notEqual(response.statusCode,200,response.body);
 }
 const stored=f.db.prepare('SELECT data_json FROM wb_memory_retrievals WHERE retrieval_id=?').get(delivered.receipt.retrieval_id);
 assert.equal(JSON.parse(stored.data_json).references[0].memory_id,note.memory_id);assert.doesNotMatch(stored.data_json,/Context receipt secret|session_ref/);
});

test('a replacement continuation appends its own trace without overwriting an earlier binding observation',t=>{
 const f=fixture(t);f.save({});const original=f.run(),next=f.run();
 f.db.prepare('DELETE FROM wb_run_bindings WHERE run_id=?').run(next.run_id);
 f.service.inheritChatRun('alice',original.run_id,next.run_id);
 const traces=f.service.memoryRetrievals.list('alice','ws',f.agent.agent_id).items.filter(item=>item.run_id===next.run_id);assert.equal(traces.length,2);assert.deepEqual(new Set(traces.map(item=>item.kind)),new Set(['context_snapshot','continuation_snapshot']));
});
