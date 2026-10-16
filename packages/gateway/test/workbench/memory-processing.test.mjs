import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openProductDatabase,withImmediateTransaction} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {MemoryProcessingRegistry} from '../../src/workbench/memory-processing.ts';
function fixture(t){
 const base=resolve('.test-tmp/memory-processing');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(root,'db.sqlite')),service=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'files')}),events=new EventStore(db),runs=new RunRepository(db,events),conversations=new ConversationRepository(db),agent=service.createAgent('alice',{name:'Reader'});
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 service.memoryCapture.setPolicy('alice',agent.agent_id,{expected_version:0,mode:'suggest'});const source=service.enqueueAgentMessage('alice',agent.agent_id,{text:'A lasting preference',client_message_id:'source'});withImmediateTransaction(db,()=>runs.finalizePublication(source.run_id,'succeeded',null));service.collectMemoryCaptures();const capture=service.memoryCapture.list('alice',agent.agent_id).items[0];
 let bound=0,fail=false;const ports={actor:(owner,id)=>service.getAgent(owner,id),source:(owner,id,captureId)=>service.memoryCapture.get(owner,id,captureId),createRun:(owner,actor)=>{const c=conversations.create(owner,{workspace_id:actor.workspace_id,project_id:actor.project_id,title:'Internal memory extraction',model:{provider:'fixture',model:'fixture'}});return runs.enqueue(c.conversation_id,owner,{client_message_id:'internal-source',content:[{type:'text',text:'Extract only the bound public source batch.'}]});},bindRun:()=>{if(fail)throw Error('budget_service_unavailable');bound++;}};
 return {db,service,agent,source,capture,ports,registry:new MemoryProcessingRegistry(db,ports),bound:()=>bound,fail:()=>{fail=true;}};
}
test('one source batch creates one durable processing identity and replay never spends or creates again',t=>{
 const f=fixture(t),job=f.registry.prepare('alice',f.agent.agent_id,f.capture.capture_id);assert.equal(job.source_run_id,f.source.run_id);assert.notEqual(job.processor_run_id,f.source.run_id);assert.equal(f.bound(),1);
 assert.deepEqual(f.registry.prepare('alice',f.agent.agent_id,f.capture.capture_id),job);assert.equal(f.bound(),1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_processing_runs').get().n,1);
 const reopened=new MemoryProcessingRegistry(f.db,f.ports);assert.deepEqual(reopened.get('alice',f.agent.agent_id,f.capture.capture_id),job);
 assert.throws(()=>reopened.get('bob',f.agent.agent_id,f.capture.capture_id),/agent_not_found/);
});
test('active foreground work, obsolete policy and unavailable source never allocate a processing run',t=>{
 const f=fixture(t),before=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,foreground=f.service.enqueueAgentMessage('alice',f.agent.agent_id,{text:'User work first',client_message_id:'foreground'});
 assert.throws(()=>f.registry.prepare('alice',f.agent.agent_id,f.capture.capture_id),/memory_processing_busy/);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before+1);
 f.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(foreground.run_id);f.service.memoryCapture.setPolicy('alice',f.agent.agent_id,{expected_version:1,mode:'off'});assert.throws(()=>f.registry.prepare('alice',f.agent.agent_id,f.capture.capture_id),/memory_processing_source_unavailable/);assert.equal(f.bound(),0);
});
test('budget failure rolls back the processing identity, internal conversation and original outbox together',t=>{
 const f=fixture(t),counts=()=>['ga_runs','ga_conversations','ga_outbox'].map(table=>f.db.prepare('SELECT count(*) n FROM '+table).get().n),before=counts();f.fail();assert.throws(()=>f.registry.prepare('alice',f.agent.agent_id,f.capture.capture_id),/budget_service_unavailable/);assert.deepEqual(counts(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_processing_runs').get().n,0);
});
