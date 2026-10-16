import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {buildServer} from '../../src/server.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
const token='test-ae27e7949c2b46cf',limits={tokens:5000,nano_usd:50000,model_calls:20};
async function fixture(t){
 const base=resolve('.test-tmp/memory-model-admission');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 const f=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),templateRoot:resolve('file-engine/templates'),internalChannelToken:token,modelBudgetPolicy:{revision:1,admission_route:{provider:'fixture',model:'bounded'},routes:[{provider:'fixture',model:'bounded',revision:'one',context_window:100,max_output_tokens:20,rates:{input:1,output:1,cache_read:1,cache_write:1}}],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(k=>[k,limits]))}});
 t.after(async()=>{await f.app.close();f.db.close();const child=relative(base,resolve(root));assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const role=f.workbench.createAgent('alice',{name:'Curator'});f.workbench.memoryCapture.setPolicy('alice',role.agent_id,{expected_version:0,mode:'suggest'});const source=f.workbench.enqueueAgentMessage('alice',role.agent_id,{text:'Prefer concise answers',client_message_id:'source'});f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(source.run_id);f.workbench.collectMemoryCaptures();const capture=f.workbench.memoryCapture.list('alice',role.agent_id).items[0],job=f.workbench.prepareMemoryProcessing('alice',role.agent_id,capture.capture_id),session=new SessionBindingRepository(f.db).getOrCreate('alice',job.conversation_id).session_id;
 const coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimMemoryExtraction('worker',30000,job.processor_run_id);coordinator.start(lease);
 const binding={run_id:job.processor_run_id,session_ref:session,execution_lease:{owner:lease.owner,generation:lease.generation}};
 const post=(action,extra={})=>f.app.inject({method:'POST',url:'/internal/v1/workbench/model-budget',headers:{authorization:`Bearer ${token}`},payload:{...binding,action,...extra}});
 const reserve=id=>post('reserve',{request:{attempt_id:id,provider:'fixture',model:'bounded',max_tokens:20}});
 return {...f,role,capture,job,binding,post,reserve};
}
test('a settled extraction call without a proposal cannot be spent again by another Host',async t=>{
 const f=await fixture(t);assert.equal((await f.reserve('first')).statusCode,200);assert.equal((await f.post('dispatch',{attempt_id:'first'})).statusCode,200);assert.equal((await f.post('settle',{attempt_id:'first',usage:{inputTokens:5,outputTokens:5,totalTokens:10}})).statusCode,200);
 const retry=await f.reserve('replacement-host');assert.equal(retry.statusCode,409,retry.body);assert.equal(f.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id='replacement-host'").get(f.job.processor_run_id).n,0);assert.equal(f.workbench.memoryCapture.get('alice',f.role.agent_id,f.capture.capture_id).status,'ready');
});
test('only one extraction dispatch acknowledgement can authorize the original provider call',async t=>{
 const f=await fixture(t);assert.equal((await f.reserve('first')).statusCode,200);const replies=await Promise.all([f.post('dispatch',{attempt_id:'first'}),f.post('dispatch',{attempt_id:'first'})]);assert.deepEqual(replies.map(r=>r.statusCode).sort(),[200,409]);assert.equal(f.db.prepare("SELECT count(*) n FROM wb_model_budget_events WHERE run_id=? AND state='in_flight'").get(f.job.processor_run_id).n,1);
});
test('never-dispatched extraction reservations can close and a fresh attempt retains the original budget',async t=>{
 const f=await fixture(t);assert.equal((await f.reserve('never-started')).statusCode,200);assert.equal((await f.reserve('competing')).statusCode,409);assert.equal((await f.post('release',{attempt_id:'never-started'})).statusCode,200);assert.equal((await f.reserve('fresh')).statusCode,200);assert.equal((await f.post('dispatch',{attempt_id:'fresh'})).statusCode,200);
});
