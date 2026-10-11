import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { openProductDatabase, withImmediateTransaction } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { ConversationRepository } from '../../src/conversations/repository.ts';
import { HarnessCoordinator } from '../../src/harness/coordinator.ts';
import { WorkbenchService } from '../../src/workbench/service.ts';
import { PersistentTaskService } from '../../src/persistent-tasks/service.ts';
function fixture(t,options={maxBackgroundRuns:1,allowBackgroundRuns:true}){
 const base='.test-tmp';mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'background-coordinator-'));const db=openProductDatabase(join(root,'fixture.sqlite'));
 const events=new EventStore(db);const runs=new RunRepository(db,events);const conversations=new ConversationRepository(db);const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'shared')});const tasks=new PersistentTaskService(db,workbench);
 let now=Date.parse('2026-10-01T00:00:00Z');const coordinator=new HarnessCoordinator(db,runs,events,()=>now,options);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return{db,runs,events,conversations,workbench,tasks,coordinator,advance(ms){now+=ms;},background(owner='alice',priority=50){const a=workbench.createAgent(owner,{name:'Reader'});const task=tasks.create(owner,{title:'Check',agent_id:a.agent_id,objective:'Check',trigger:{kind:'once'},priority});return tasks.runNow(owner,task.task_id,'now').run_id;},interactive(owner='alice'){const c=conversations.create(owner,{workspace_id:'ws',model:{provider:'harness',model:'automatic'}});return String(runs.enqueue(c.conversation_id,owner,{client_message_id:'user',content:[{type:'text',text:'Reply'}]}).run_id);}};
}
test('interactive run claims before earlier background and background tasks honor user priority',t=>{
 const f=fixture(t,{maxBackgroundRuns:2,allowBackgroundRuns:true});const low=f.background('alice',0);const high=f.background('alice',100);const user=f.interactive();
 assert.equal(f.coordinator.claimNext('worker-a',10000).run_id,user);assert.equal(f.coordinator.claimNext('worker-b',10000).run_id,high);assert.equal(f.coordinator.claimNext('worker-c',10000).run_id,low);
});
test('background active lease quota reserves capacity for interactive runs across owners',t=>{
 const f=fixture(t);const first=f.background('alice');const second=f.background('bob');assert.equal(f.coordinator.claimNext('worker-a',10000).run_id,first);
 assert.equal(f.coordinator.claimNext('worker-b',10000),null);const user=f.interactive('bob');assert.equal(f.coordinator.claimNext('worker-b',10000).run_id,user);
 withImmediateTransaction(f.db,()=>f.runs.finalizePublication(first,'succeeded',null));assert.equal(f.coordinator.claimNext('worker-c',10000).run_id,second);
});
test('not-ready coordinator excludes all role-bound runs but keeps ordinary chat',t=>{
 const f=fixture(t,{maxBackgroundRuns:1,allowBackgroundRuns:false});f.background();const role=f.workbench.createAgent('alice',{name:'Reader'});f.workbench.enqueueAgentMessage('alice',role.agent_id,{text:'Read',client_message_id:'role-chat'});
 const ordinary=f.interactive();assert.equal(f.coordinator.claimNext('worker-a',10000).run_id,ordinary);assert.equal(f.coordinator.claimNext('worker-b',10000),null);
});
test('expired background lease recovery participates in the same quota',t=>{
 const f=fixture(t);const first=f.background();f.coordinator.claimNext('worker-a',100);f.advance(101);const other=f.background('bob',100);const lease=f.coordinator.claimNext('worker-b',10000);assert.equal(lease.run_id,other);
 assert.equal(f.coordinator.claimNext('worker-c',10000),null);withImmediateTransaction(f.db,()=>f.runs.finalizePublication(other,'succeeded',null));assert.equal(f.coordinator.claimNext('worker-c',10000).run_id,first);
});
test('workbench roles without task tables still claim with default background priority',t=>{
 const f=fixture(t);f.db.exec('DROP TABLE wb_task_create_requests; DROP TABLE wb_task_subtasks; DROP TABLE wb_task_occurrences; DROP TABLE wb_persistent_tasks');
 const role=f.workbench.createAgent('alice',{name:'Reader'});const receipt=f.workbench.enqueueAgentMessage('alice',role.agent_id,{text:'Read',client_message_id:'role'});
 assert.equal(f.coordinator.claimNext('worker-a',1000).run_id,receipt.run_id);
});
