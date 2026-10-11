import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {buildServer} from '../../src/server.ts';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {HarnessWorker} from '../../src/harness/worker.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
const limit={tokens:5000,nano_usd:50000,model_calls:50};
const route={provider:'fixture',model:'bounded',revision:'rates-1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}};
const policy={revision:1,admission_route:{provider:'fixture',model:'bounded'},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limit]))};
async function fixture(t,withFile=false){
 const base=resolve('.test-tmp/task-continuation');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 const f=await buildServer({databasePath:join(root,'fixture.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),internalChannelToken:'test-b99992d64419ae59',modelBudgetPolicy:policy,csrfToken:'test-dcbf055943f33d8a',allowedOrigins:['https://fixture.invalid']});
 const additionalConnections=[];
 t.after(async()=>{for(const connection of additionalConnections){await connection.app.close();connection.db.close();}await f.app.close();f.db.close();const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const a=f.workbench.createAgent('alice',{name:'Reader',instructions:'Frozen reader duties'});
 const task=f.persistentTasks.create('alice',{title:'Continue controlled task',agent_id:a.agent_id,objective:'Read then produce report',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 const occurrence=f.persistentTasks.runNow('alice',task.task_id,'original');const runId=occurrence.run_id,now=new Date().toISOString();
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(runId);
 f.modelBudgets.reserve('alice',runId,{attempt_id:'spent',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',runId,'spent');f.modelBudgets.settle('alice',runId,'spent',{inputTokens:20,outputTokens:5,totalTokens:25});
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(occurrence.conversation_id,'alice','session-fixture',now,now);
 f.db.prepare('INSERT INTO wb_native_goal_bindings VALUES(?,?,?,?,?,?)').run(runId,occurrence.occurrence_id,'goal-fixture',7,now,now);
 const savedProof=withFile?withImmediateTransaction(f.db,()=>{
  const written=f.workbench.writeFile('alice','ws',{project_id:a.project_id,path:'controlled.md',content:'Original checked output',expected_version:0},runId);
  return new TaskExecutionEvidence(f.db).record(runId,'old-proof','files.write',written);
 }):undefined;
 const checkpointCoordinator=new HarnessCoordinator(f.db,f.runs,f.events),checkpointLease=checkpointCoordinator.claimNext('checkpoint-fixture-worker',30000);
 const checkpointId=checkpointCoordinator.recordCheckpoint(checkpointLease,'session-fixture',{session_ref:'session-fixture',seq_exclusive:3,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:7,log_sha256:'a'.repeat(64)});
 checkpointCoordinator.interruptWithoutRuntime(checkpointLease,'SESSION_TURN_INTERRUPTED');
 const headers={'x-user-id':'alice','idempotency-key':'resume-fixture',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a'};
 const resume=(id=runId,key='resume-fixture',owner='alice')=>f.app.inject({method:'POST',url:`/v1/runs/${id}/resume`,headers:{...headers,'x-user-id':owner,'idempotency-key':key},payload:{expected_run_version:f.runs.get(id,'alice').version,checkpoint_id:checkpointId}});
 const scopes=id=>JSON.parse(f.db.prepare('SELECT allocation_json FROM wb_budget_allocations WHERE run_id=?').get(id).allocation_json).scopes;
 return {...f,a,task,occurrence,runId,root,resume,scopes,additionalConnections,checkpointId,savedProof};
}
test('checkpoint recovery stays in one occurrence and preserves goal, frozen role, proof and cumulative scopes',async t=>{
 const f=await fixture(t,true),proofs=new TaskExecutionEvidence(f.db),proof=f.savedProof;
 const step=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Saved checkpoint step',status:'completed',evidence:[proof]});
 const before=f.scopes(f.runId);const r=await f.resume();assert.equal(r.statusCode,202,r.body);const next=r.json().run_id;
 assert.notEqual(next,f.runId);assert.equal(f.runs.get(next,'alice').conversation_id,f.occurrence.conversation_id);assert.equal(f.runs.get(next,'alice').continuation_of,f.runId);
 assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);
 assert.deepEqual(f.persistentTasks.subtasks('alice',f.task.task_id).items,[step]);
 assert.deepEqual(f.persistentTasks.subtasks('alice',f.task.task_id,f.occurrence.occurrence_id).items,[step]);
 assert.equal(f.db.prepare('SELECT occurrence_id FROM wb_task_subtask_scope WHERE task_id=?').get(f.task.task_id).occurrence_id,f.occurrence.occurrence_id);
 assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items.length,1);assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].run_id,next);
 assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].status,'queued');
 assert.equal(f.workbench.contextForRun(next).instructions,'Frozen reader duties');assert.deepEqual(f.scopes(next),before);
 for(const scope of before){const b=f.modelBudgets.balance('alice',scope.scope_id);assert.equal(b.used.tokens,'25');assert.equal(b.used.nano_usd,'90');assert.equal(b.held.tokens,'100');}
 const guard=await f.app.inject({method:'POST',url:'/internal/v1/workbench/guard',headers:{authorization:'Bearer test-b99992d64419ae59'},payload:{run_id:next,session_ref:'session-fixture'}});assert.equal(guard.statusCode,200,guard.body);
 assert.equal(guard.json().context.task_binding.root_run_id,f.runId);assert.equal(guard.json().context.task_binding.continuation_of,f.runId);
 const goal=await f.app.inject({method:'POST',url:'/internal/v1/workbench/goal-binding',headers:{authorization:'Bearer test-b99992d64419ae59'},payload:{run_id:next,session_ref:'session-fixture',action:'get'}});assert.equal(goal.statusCode,200,goal.body);assert.deepEqual(goal.json().binding,{goal_id:'goal-fixture',goal_revision:7});
 const freshProof=withImmediateTransaction(f.db,()=>{
  const written=f.workbench.writeFile('alice','ws',{project_id:f.a.project_id,path:'continued.md',content:'Continued checked output',expected_version:0},next);
  return proofs.record(next,'new-proof','files.write',written);
 });assert.equal(proofs.verified('alice',f.task.task_id,proof,f.occurrence.occurrence_id),true);assert.equal(proofs.verified('alice',f.task.task_id,freshProof,f.occurrence.occurrence_id),true);assert.equal(proofs.verified('bob',f.task.task_id,freshProof),false);
 const replay=await f.resume();assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().run_id,next);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);
 assert.throws(()=>f.persistentTasks.runNow('alice',f.task.task_id,'must-not-start-new-occurrence'),/task_active_occurrence/);
});
test('unknown costs, missing native binding, revoked generation and missing ownership cannot resume a task',async t=>{
 for(const condition of ['unknown','in_flight','goal_missing','session_missing','paused','cancelled_occurrence','foreign']){
  const f=await fixture(t);
  if(['unknown','in_flight'].includes(condition)){
   f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.runId);f.modelBudgets.reserve('alice',f.runId,{attempt_id:'pending',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',f.runId,'pending');if(condition==='unknown')f.modelBudgets.markUnknown('alice',f.runId,'pending','stream_incomplete');f.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(f.runId);
  }else if(condition==='goal_missing')f.db.prepare('DELETE FROM wb_native_goal_bindings').run();
  else if(condition==='session_missing')f.db.prepare('DELETE FROM ga_harness_session_bindings').run();
  else if(condition==='paused')f.persistentTasks.pause('alice',f.task.task_id,1);
  else if(condition==='cancelled_occurrence')f.db.prepare('UPDATE wb_task_occurrences SET generation=-1').run();
  const response=await f.resume(f.runId,'reject-'+condition,condition==='foreign'?'bob':'alice');assert.equal(response.statusCode,condition==='foreign'?404:409,response.body);
  assert.equal(response.json().error.code,['unknown','in_flight'].includes(condition)?'BUDGET_USAGE_UNKNOWN':['goal_missing','session_missing'].includes(condition)?'TASK_CHECKPOINT_UNAVAILABLE':condition==='foreign'?'RUN_NOT_FOUND':'TASK_GENERATION_REVOKED');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1,condition);assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);
 }
});
test('new keys cannot fork the same checkpoint and pause cancels the continuation leaf',async t=>{
 const f=await fixture(t),first=await f.resume();assert.equal(first.statusCode,202,first.body);const next=first.json().run_id;
 const fork=await f.resume(f.runId,'different-resume-key');assert.equal(fork.statusCode,409,fork.body);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);
 f.persistentTasks.pause('alice',f.task.task_id,1);assert.equal(f.runs.get(next,'alice').status,'cancelled');assert.throws(()=>f.workbench.assertRunActive(next),/task_generation_revoked/);assert.throws(()=>f.persistentTasks.assertRunActive(next),/task_generation_revoked/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_goal_bindings').get().n,1);
});
test('worker resumes persistent Session with continuation instruction rather than the original action request',async t=>{
 const f=await fixture(t),r=await f.resume();assert.equal(r.statusCode,202,r.body);let sent;
 const coordinator=new HarnessCoordinator(f.db,f.runs,f.events);
 const worker=new HarnessWorker(f.db,coordinator,{run:async input=>{sent=input;return {observed:true,completed:true,reason_code:'CHAT',runtime_status:'not_required',final_text:'Controlled continuation result'};}},{workerId:'fixture-worker',leaseMs:30000,sessionResolver:()=> 'session-fixture',executionGuard:{assertRunActive:id=>{f.workbench.assertRunActive(id);f.persistentTasks.assertRunActive(id);},contextForRun:id=>f.workbench.contextForRun(id)}});
 await worker.processNext();assert.equal(sent.taskRequestId,r.json().run_id);assert.equal(sent.sessionRef,'session-fixture');assert.match(sent.message,/继续/);assert.doesNotMatch(sent.message,/持续任务：|本次执行：/);assert.match(sent.message,/不要.*重新|不要.*重复/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0,'Session recovery is not business acceptance');
 assert.equal(f.runs.get(r.json().run_id,'alice').error_code,'TASK_BUSINESS_REVIEW_REQUIRED');
 assert.equal(f.db.prepare('SELECT status FROM ga_candidate_answers WHERE run_id=?').get(r.json().run_id).status,'pending');
});

test('repeated checkpoint recovery retains one current occurrence, immutable lineage and original goal revision',async t=>{
 const f=await fixture(t),first=await f.resume();assert.equal(first.statusCode,202,first.body);const next=first.json().run_id;
 assert.equal(f.persistentTasks.runNow('alice',f.task.task_id,'original').run_id,next,'original trigger replay must return the current leaf');
 f.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(next);
 const second=await f.resume(next,'second-recovery');assert.equal(second.statusCode,202,second.body);const leaf=second.json().run_id;
 assert.equal(f.runs.get(leaf,'alice').continuation_of,next);assert.deepEqual(f.scopes(leaf),f.scopes(f.runId));
 assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items.length,1);assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].run_id,leaf);
 assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);
 assert.throws(()=>f.db.prepare('UPDATE wb_task_continuations SET parent_run_id=? WHERE run_id=?').run(f.runId,leaf),/task_continuation_immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_task_continuations WHERE run_id=?').run(next),/task_continuation_immutable/);
 const headers={authorization:'Bearer test-b99992d64419ae59'};
 const save=await f.app.inject({method:'POST',url:'/internal/v1/workbench/goal-binding',headers,payload:{run_id:leaf,session_ref:'session-fixture',action:'save',goal_id:'goal-fixture',goal_revision:9}});assert.equal(save.statusCode,200,save.body);
 assert.equal(f.db.prepare('SELECT goal_revision FROM wb_native_goal_bindings WHERE run_id=?').get(f.runId).goal_revision,9);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_goal_bindings').get().n,1);
 const stale=await f.app.inject({method:'POST',url:'/internal/v1/workbench/goal-binding',headers,payload:{run_id:leaf,session_ref:'session-fixture',action:'save',goal_id:'goal-fixture',goal_revision:8}});assert.equal(stale.statusCode,409,stale.body);
 const oldGuard=await f.app.inject({method:'POST',url:'/internal/v1/workbench/guard',headers,payload:{run_id:f.runId,session_ref:'session-fixture'}});assert.equal(oldGuard.statusCode,409,oldGuard.body);
 const cancelled=f.persistentTasks.cancelOccurrence('alice',f.task.task_id,f.occurrence.occurrence_id,f.runs.get(leaf,'alice').version,'cancel-leaf');assert.equal(cancelled.run_id,leaf);assert.equal(f.runs.get(leaf,'alice').status,'cancelled');
});

test('insufficient cumulative budget rolls back the recovery run, lineage and commands',async t=>{
 const f=await fixture(t),headers={'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':'set-ceiling'};
 const set=await f.app.inject({method:'PATCH',url:`/v1/persistent-tasks/${f.task.task_id}/model-budget`,headers,payload:{expected_version:0,limits:{tokens:25,nano_usd:90,model_calls:1}}});assert.equal(set.statusCode,200,set.body);
 const before=f.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n;
 const response=await f.resume();assert.equal(response.statusCode,429,response.body);assert.equal(response.json().error.code,'MODEL_BUDGET_EXHAUSTED');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_continuations').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,before);
 for(const scope of f.scopes(f.runId)){const b=f.modelBudgets.balance('alice',scope.scope_id);assert.equal(b.used.tokens,'25');assert.equal(b.held.tokens,'0');}
});

test('another Gateway connection restores the current checkpoint chain and cannot bypass unknown child consumption',async t=>{
 const f=await fixture(t),first=await f.resume();assert.equal(first.statusCode,202,first.body);const next=first.json().run_id;
 const reopened=await buildServer({databasePath:join(f.root,'fixture.sqlite'),workspaces:['ws'],workbenchRoot:join(f.root,'files'),uploadRoot:join(f.root,'uploads'),internalChannelToken:'test-b99992d64419ae59',modelBudgetPolicy:policy,csrfToken:'test-dcbf055943f33d8a',allowedOrigins:['https://fixture.invalid']});
 f.additionalConnections.push(reopened);
 assert.equal(reopened.persistentTasks.occurrences('alice',f.task.task_id).items[0].run_id,next);
 assert.equal(reopened.persistentTasks.runNow('alice',f.task.task_id,'original').run_id,next);
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(next);
 f.modelBudgets.reserve('alice',next,{attempt_id:'unknown-child',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',next,'unknown-child');f.modelBudgets.markUnknown('alice',next,'unknown-child','stream_incomplete');
 f.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(next);
 const budget=await reopened.app.inject({method:'GET',url:`/v1/persistent-tasks/${f.task.task_id}/model-budget`,headers:{'x-user-id':'alice'}});assert.equal(budget.statusCode,200,budget.body);assert.equal(budget.json().pending_unknown,1);assert.ok(budget.json().blocking_reasons.includes('usage_unknown'));
 const response=await reopened.app.inject({method:'POST',url:`/v1/runs/${next}/resume`,headers:{'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':'reopened-recovery'},payload:{expected_run_version:reopened.runs.get(next,'alice').version,checkpoint_id:f.checkpointId}});
 assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error.code,'BUDGET_USAGE_UNKNOWN');assert.equal(reopened.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);
});
