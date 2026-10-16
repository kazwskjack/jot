import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {buildServer} from '../../src/server.ts';
import {maintainWorkbench} from '../../src/persistent-tasks/scheduler.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';

test('enabling the original worker never resumes paused tasks with stale queued occurrence projections',async t=>{
 const base=resolve('.test-tmp/memory-enablement');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 const limits={tokens:50000,nano_usd:500000,model_calls:100};
 const f=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),templateRoot:resolve('file-engine/templates'),modelBudgetPolicy:{revision:1,admission_route:{provider:'fixture',model:'bounded'},routes:[{provider:'fixture',model:'bounded',revision:'one',context_window:100,max_output_tokens:20,rates:{input:1,output:1,cache_read:1,cache_write:1}}],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(k=>[k,limits]))}});
 t.after(async()=>{await f.app.close();f.db.close();const child=relative(base,resolve(root));assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const role=f.workbench.createAgent('alice',{name:'Paused owner tasks'}),tasks=f.persistentTasks;
 for(let i=0;i<12;i++){
  let task=tasks.create('alice',{title:'Paused '+i,agent_id:role.agent_id,objective:'Read public information',trigger:{kind:'once'}});
  const occurrence=tasks.runNow('alice',task.task_id,'original-'+i);task=tasks.pause('alice',task.task_id,task.version);
  // A legacy projection can lag the authoritative cancelled ga_run. It is
  // display state, never a new owner authorization or a reason to resume.
  f.db.prepare("UPDATE wb_task_occurrences SET status='queued' WHERE occurrence_id=?").run(occurrence.occurrence_id);
 }
 const snapshot=()=>f.db.prepare('SELECT task_id,status,version,generation FROM wb_persistent_tasks ORDER BY task_id').all();const before=snapshot();
 assert.equal(before.length,12);assert.ok(before.every(row=>row.status==='paused'));
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_task_occurrences WHERE status='queued'").get().n,12);
 const runs=Number(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n),coordinator=new HarnessCoordinator(f.db,f.runs,f.events,Date.now,{maxBackgroundRuns:4,allowBackgroundRuns:true});
 for(const ready of [false,true,true]){await maintainWorkbench(f.workbench,tasks,ready);assert.equal(coordinator.claimNext('upgraded-worker',30000),null);assert.deepEqual(snapshot(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,runs);}
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE state IN ('in_flight','settled','unknown')").get().n,0);
 const control=tasks.create('alice',{title:'Separately authorized control',agent_id:role.agent_id,objective:'Read public information',trigger:{kind:'once'}}),run=tasks.runNow('alice',control.task_id,'control');
 const lease=coordinator.claimNext('upgraded-worker',30000);assert.equal(lease.run_id,run.run_id);assert.deepEqual(snapshot().filter(row=>row.task_id!==control.task_id),before);
});
