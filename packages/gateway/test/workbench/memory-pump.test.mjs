import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {WorkbenchBudgetPolicy} from '../../src/workbench/model-budget-policy.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {MemoryExtractionPump} from '../../src/harness/memory-extraction-pump.ts';
function fixture(t){
 const base=resolve('.test-tmp/memory-pump');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(root,'db.sqlite'));
 const limits={tokens:5000,nano_usd:50000,model_calls:20},policy=new WorkbenchBudgetPolicy(db,{revision:1,admission_route:{provider:'fixture',model:'fixture'},routes:[{provider:'fixture',model:'fixture',revision:'one',context_window:100,max_output_tokens:20,rates:{input:1,output:1,cache_read:1,cache_write:1}}],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limits]))});
 const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'files'),modelBudgetPolicy:policy}),events=new EventStore(db),runs=new RunRepository(db,events),coordinator=new HarnessCoordinator(db,runs,events),sessions=new SessionBindingRepository(db),agent=workbench.createAgent('alice',{name:'Reader'});t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 workbench.memoryCapture.setPolicy('alice',agent.agent_id,{expected_version:0,mode:'suggest'});const source=workbench.enqueueAgentMessage('alice',agent.agent_id,{text:'Prefer clear answers',client_message_id:'source'});db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(source.run_id);workbench.collectMemoryCaptures();const capture=workbench.memoryCapture.list('alice',agent.agent_id).items[0];let calls=0,creates=0,ready=true;
 const client={memoryExtractionReadiness:async()=>({ready}),create:async()=>{creates++;},extractMemory:async(session,runId,signal)=>{signal.throwIfAborted();calls++;policy.ledger.reserve('alice',runId,{attempt_id:'one-call',provider:'fixture',model:'fixture',max_tokens:20});policy.ledger.dispatch('alice',runId,'one-call');policy.ledger.settle('alice',runId,'one-call',{inputTokens:5,outputTokens:5,totalTokens:10});const packet=workbench.memoryCapture.get('alice',agent.agent_id,capture.capture_id);return workbench.memoryCapture.propose('alice',agent.agent_id,capture.capture_id,{expected_version:packet.version,summary:'Preference',notes:[{content:'Prefers clear answers.',source_ids:[packet.sources[0].source_id]}]},runId);}};
 const make=(enabled=true)=>new MemoryExtractionPump(db,workbench,coordinator,client,{enabled,workerId:'idle-slot',leaseMs:30000,cwd:root,sessionResolver:id=>sessions.getOrCreateForConversation(id).session_id});
 return {db,workbench,agent,source,capture,policy,client,make,calls:()=>calls,creates:()=>creates,unready:()=>{ready=false;}};
}
test('idle pump proposes once on the original processing run and never applies memory',async t=>{
 const f=fixture(t),pump=f.make(),result=await pump.processNext();assert.equal(result.runtime_status,'memory_proposed');assert.equal(f.calls(),1);assert.equal(f.creates(),1);assert.equal(f.workbench.memoryCapture.get('alice',f.agent.agent_id,f.capture.capture_id).processing.status,'succeeded');assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(result.run_id).status,'succeeded');assert.equal(f.workbench.listMemory('alice','ws',{agent_id:f.agent.agent_id}).items.length,0);assert.equal(await pump.processNext(),null);assert.equal(f.calls(),1);
});
test('disabled or unavailable extraction Host cannot allocate a run or model admission',async t=>{
 const f=fixture(t),before=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;assert.equal(await f.make(false).processNext(),null);f.unready();assert.equal(await f.make().processNext(),null);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before);assert.equal(f.calls(),0);
});
test('foreground work leaves the source queued for later without spending',async t=>{
 const f=fixture(t);f.workbench.enqueueAgentMessage('alice',f.agent.agent_id,{text:'Main work',client_message_id:'main'});assert.equal(await f.make().processNext(),null);assert.equal(f.calls(),0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_processing_runs').get().n,0);
});


test('a lost Host response recovers only its committed proposal and settled usage without another model call',async t=>{
 const f=fixture(t),extract=f.client.extractMemory;f.client.extractMemory=async(...args)=>{await extract(...args);throw Error('response_lost');};const result=await f.make().processNext();assert.equal(result.runtime_status,'memory_proposed');assert.equal(f.calls(),1);assert.equal(await f.make().processNext(),null);assert.equal(f.calls(),1);
});
test('unknown provider usage blocks replay and retains the original held cost',async t=>{
 const f=fixture(t);let actual=0;f.client.extractMemory=async(session,run)=>{actual++;f.policy.ledger.reserve('alice',run,{attempt_id:'unknown-call',provider:'fixture',model:'fixture',max_tokens:20});f.policy.ledger.dispatch('alice',run,'unknown-call');f.policy.ledger.markUnknown('alice',run,'unknown-call','stream_incomplete');throw Error('stream_lost');};const result=await f.make().processNext();assert.equal(result.runtime_status,'memory_reconciliation_required');assert.equal(f.db.prepare("SELECT state FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id='unknown-call'").get(result.run_id).state,'unknown');assert.equal(await f.make().processNext(),null);assert.equal(actual,1);assert.equal(f.workbench.memoryCapture.get('alice',f.agent.agent_id,f.capture.capture_id).status,'ready');
});
