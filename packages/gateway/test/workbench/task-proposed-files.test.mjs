import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './task-wait-fixture.mjs';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {currentTaskCompletionCandidate,freezeTaskCompletionCandidate} from '../../src/persistent-tasks/completion-candidates.ts';

function write(f,owner='alice',receipted=true){
 const project=f.workbench.contextForRun(f.runId).project_id;
 return withImmediateTransaction(f.db,()=>{
  const value=f.workbench.writeFile(owner,'ws',{project_id:project,path:'report.md',content:'Original report',expected_version:0},receipted?f.runId:undefined);
  return receipted?new TaskExecutionEvidence(f.db).record(f.runId,'file-output','files.write',value):undefined;
 });
}
async function outputFixture(t,options={}){
 return fixture(t,'complete',{candidate:{text:'Review this report'},proposalFiles:[{path:'report.md',description:'Reviewed report'}],prepare:f=>{
  const proof=write(f);f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Write output',acceptance:'The report matches the requested content.',status:'completed',evidence:[proof]},f.runId);
 },...options});
}

test('a completed task proposal freezes its own declared output without a synthetic native present event',async t=>{
 const f=await outputFixture(t),frozen=currentTaskCompletionCandidate(f.db,'alice',f.runId);
 assert.equal(frozen.candidate.presented_files,undefined);assert.deepEqual(frozen.candidate.workspace_files,[{path:'report.md',description:'Reviewed report'}]);
 const output=frozen.snapshot.workspace_file_outputs[0];assert.equal(output.version,1);assert.equal(output.verified,true);assert.equal(output.content_verified,true);
 const proposed=JSON.parse(f.db.prepare('SELECT snapshot_json FROM wb_task_goal_proposals WHERE run_id=?').get(f.runId).snapshot_json);
 assert.deepEqual(proposed.workspace_file_outputs,[output]);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_events WHERE type='deliverables/presented'").get().n,0);
 const project=f.workbench.contextForRun(f.runId).project_id;f.workbench.writeFile('alice','ws',{project_id:project,path:'report.md',content:'Later replacement',expected_version:1});
 assert.deepEqual(currentTaskCompletionCandidate(f.db,'alice',f.runId).snapshot.workspace_file_outputs,[output]);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_business_certificates').get().n,0);
});

test('invalid output declarations never become a stored proposal',async t=>{
 const invalid=[[],Array.from({length:9},(_,i)=>({path:`file-${i}.md`})),[{path:'../private.md'}],[{path:'/absolute.md'}],[{path:'a\\b.md'}],[{path:'report.md',owner:'foreign'}],[{path:'report.md',version:1}],[{path:'report.md'},{path:'report.md'}]];
 for(const files of invalid){let observed;await assert.rejects(outputFixture(t,{proposalFiles:files,prepare:f=>{observed=f;const proof=write(f);f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Write',acceptance:'Check output',status:'completed',evidence:[proof]},f.runId);}}));assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_goal_proposals').get().n,0);}
});

test('an owned manual file without a current occurrence write receipt cannot be proposed as an output',async t=>{
 let observed;await assert.rejects(outputFixture(t,{prepare:f=>{observed=f;write(f,'alice',false);const proof=new TaskExecutionEvidence(f.db).record(f.runId,'list-output','files.list',{items:[]});f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'List',acceptance:'Check output',status:'completed',evidence:[proof]},f.runId);}}));
 assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_goal_proposals').get().n,0);assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_completion_candidates').get().n,0);
});

test('file declarations are complete-only and do not silently change a wait or continuation request',async t=>{
 for(const intent of ['continue','wait_user','wait_approval']){let observed;await assert.rejects(fixture(t,intent,{proposalFiles:[{path:'report.md'}],prepare:f=>{observed=f;}}));assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_goal_proposals').get().n,0);assert.equal(observed.db.prepare('SELECT business_state FROM wb_task_occurrences').get().business_state,'queued');}
});

test('other owner or project files and an unreferenced write receipt cannot be declared as current outputs',async t=>{
 for(const condition of ['owner','project','unreferenced']){let observed;
  await assert.rejects(outputFixture(t,{prepare:f=>{observed=f;
   if(condition==='unreferenced')write(f);
   else{const owner=condition==='owner'?'bob':'alice',project=f.projects.create(owner,{title:'Other files'});f.workbench.writeFile(owner,'ws',{project_id:project.project_id,path:'report.md',content:'Private other file',expected_version:0});}
   const proof=new TaskExecutionEvidence(f.db).record(f.runId,'list-only','files.list',{items:[]});f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'List',acceptance:'Read the listing',status:'completed',evidence:[proof]},f.runId);
  }}));assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_goal_proposals').get().n,0,condition);
 }
});

test('a historical occurrence write cannot be reused as the next occurrence output',async t=>{
 let observed;
 await assert.rejects(outputFixture(t,{beforeRun:f=>{
  const old=f.persistentTasks.runNow('alice',f.task.task_id,'older-occurrence');write({...f,runId:old.run_id});f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(old.run_id);
 },prepare:f=>{observed=f;const proof=new TaskExecutionEvidence(f.db).record(f.runId,'current-list','files.list',{items:[]});f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Current listing',acceptance:'Only current evidence',status:'completed',evidence:[proof]},f.runId);}}));
 assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,2);assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_goal_proposals').get().n,0);
});

test('a proposal pins the latest version referenced by completed steps and its call ID cannot change declarations',async t=>{
 const f=await outputFixture(t,{prepare:f=>{
  const first=write(f),project=f.workbench.contextForRun(f.runId).project_id;
  const second=withImmediateTransaction(f.db,()=>{const value=f.workbench.writeFile('alice','ws',{project_id:project,path:'report.md',content:'Revised report',expected_version:1},f.runId);return new TaskExecutionEvidence(f.db).record(f.runId,'file-revision','files.write',value);});
  f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Final report',acceptance:'The latest referenced revision',status:'completed',evidence:[first,second]},f.runId);
 },afterProposal:async f=>{
  const input={...f.identity,...f.goal,call_id:'wait-proposal',intent:'complete',summary:'Which report format should I use?',files:[{path:'report.md',description:'Reviewed report'}]};
  const replay=await f.internal('goal-proposal',input);assert.equal(replay.statusCode,200,replay.body);
  const changed=await f.internal('goal-proposal',{...input,files:[{path:'report.md',description:'Changed declaration'}]});assert.equal(changed.statusCode,409,changed.body);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_goal_proposals').get().n,1);
 }});
 const frozen=currentTaskCompletionCandidate(f.db,'alice',f.runId);assert.equal(frozen.snapshot.workspace_file_outputs[0].version,2);assert.match((await f.list())[0].questions[0].description,/report.md · v2 · SHA256/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>freezeTaskCompletionCandidate(f.db,f.runId,{text:'Review this report',workspace_files:[{path:'other.md'}]})),/task_completion_state_conflict/);
});

test('mixed native and workspace sources are rejected before creating a review card, even for different paths',async t=>{
 for(const path of ['native-only.md','report.md']){
  let observed;await assert.rejects(outputFixture(t,{candidate:{text:'Review this report',presented_files:[{path,description:'Reviewed report'}]},afterProposal:f=>{observed=f;}}),/task_output_sources_conflict/);
  assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_completion_candidates').get().n,0);assert.equal(observed.db.prepare('SELECT count(*) n FROM wb_task_wait_interactions').get().n,0);assert.equal(observed.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,1);
 }
});
