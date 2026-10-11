import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {completionFixture} from './task-completion-fixture.mjs';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {prepareTaskCompletion,confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';

async function ready(t,generated=false){
 let source,group;
 const candidate={text:'The approved file is ready.',...(generated?{artifact_refs:[]}:{presented_files:[{path:'report.md'}]})};
 const f=await completionFixture(t,{candidate,prepare:f=>{
  if(generated){
   const root=f.workbench.projectRoot('alice','ws',f.workbench.contextForRun(f.runId).project_id);mkdirSync(root,{recursive:true});
   const path=join(root,'report.md');writeFileSync(path,'Reviewed process recovery bytes');
   group=f.artifacts.registerGenerated(f.runId,'process-rendered-report',[{path,display_name:'report.md'}]);candidate.artifact_refs.push(group.artifact_ref);return;
  }
  source=withImmediateTransaction(f.db,()=>{
   const file=f.workbench.writeFile('alice','ws',{project_id:f.workbench.contextForRun(f.runId).project_id,path:'report.md',content:'Reviewed process recovery bytes',expected_version:0},f.runId);
   return new TaskExecutionEvidence(f.db).record(f.runId,'process-report','files.write',file);
  });
  f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Report file',acceptance:'Contains the approved report.',status:'completed',evidence:[source]},f.runId);
 }});
 const card=(await f.list())[0],response=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});
 assert.equal(response.statusCode,202,response.body);
 const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}};
 const intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',f.runId,before));
 withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,{host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)}}));
 if(!generated)f.workbench.writeFile('alice','ws',{project_id:f.workbench.contextForRun(f.runId).project_id,path:'report.md',content:'Later replacement',expected_version:1});
 const artifactId=`artifact-${createHash('sha256').update(generated?`task-generated:${f.runId}:${group.artifact_ref}:1:1`:`task-file:${f.runId}:${source.reference}`).digest('hex').slice(0,32)}`;
 return {...f,intent,artifactId,copy:join(f.fixtureConfig.uploadRoot,'ready','generated',artifactId,'version-1.data')};
}

function child(f,boundary){
 const script=`import {buildServer} from ${JSON.stringify(new URL('../../src/server.ts',import.meta.url).href)};
 import {HarnessCoordinator} from ${JSON.stringify(new URL('../../src/harness/coordinator.ts',import.meta.url).href)};
 const f=await buildServer(${JSON.stringify(f.fixtureConfig)});
 ${boundary==='in_transaction'?`f.db.function('fixture_process_exit',()=>{process.stdout.write('boundary=in_transaction;pid='+process.pid+'\\n');process.exit(73)});
 f.db.exec("CREATE TEMP TRIGGER file_process_exit BEFORE INSERT ON wb_task_finalizations BEGIN SELECT fixture_process_exit(); END");`:''}
 const receipt=new HarnessCoordinator(f.db,f.runs,f.events).finalizeReviewedTask('alice',${JSON.stringify(f.runId)},${JSON.stringify(f.intent.intent_id)});
 ${boundary==='after_commit'?"process.stdout.write('boundary=after_commit;pid='+process.pid+'\\n');process.exit(73);":"process.stdout.write(JSON.stringify({pid:process.pid,receipt})+'\\n');await f.app.close();f.db.close();"}`;
 return spawnSync(process.execPath,['--input-type=module','-e',script],{timeout:15000,encoding:'utf8',windowsHide:true});
}

for(const generated of [false,true]){
test(`${generated?'generated part':'workspace file'}: real process exit during finalization rolls SQLite back, reuses only correct orphan bytes and recovers once in a new process`,async t=>{
 const f=await ready(t,generated),events=f.db.prepare('SELECT count(*) n FROM ga_events').get().n,balance=f.modelBudgets.balancesForRun('alice',f.runId);
 const crashed=child(f,'in_transaction');assert.equal(crashed.status,73,crashed.stderr);assert.match(crashed.stdout,/boundary=in_transaction;pid=\d+/);
 assert.equal(readFileSync(f.copy,'utf8'),'Reviewed process recovery bytes');
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_artifacts WHERE kind='task_output_file'").get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_run_artifacts').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,events);
 assert.equal(f.runs.get(f.runId,'alice').status,'waiting_approval');
 assert.equal(f.db.prepare('SELECT goal_revision FROM wb_native_goal_bindings').get().goal_revision,8);
 // A wrong file left on disk cannot be trusted merely because its directory
 // name matches the deterministic output identity.
 writeFileSync(f.copy,'Wrong orphan bytes');
 const rejected=child(f,'recover');assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/task_output_content_mismatch/);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,0);
 writeFileSync(f.copy,'Reviewed process recovery bytes');
 const recovered=child(f,'recover');assert.equal(recovered.status,0,recovered.stderr);const receipt=JSON.parse(recovered.stdout.trim()).receipt;
 assert.equal(receipt.status,'succeeded');assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,1);
 const download=await f.app.inject({url:`/v1/artifacts/${f.artifactId}/download?version=1`,headers:{'x-user-id':'alice'}});
 assert.equal(download.statusCode,200);assert.equal(download.body,'Reviewed process recovery bytes');
 const finalEvents=f.db.prepare('SELECT count(*) n FROM ga_events').get().n,replay=child(f,'recover');
 assert.equal(replay.status,0,replay.stderr);assert.deepEqual(JSON.parse(replay.stdout.trim()).receipt,receipt);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,finalEvents);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_native_completions').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
 assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),balance);
 t.diagnostic(JSON.stringify({boundary:'in_transaction',exit:73,wrong_orphan:'rejected',recovered_process_pid:JSON.parse(recovered.stdout.trim()).pid,artifact_count:1,assistant_count:1,duplicate_effects:0}));
});

test(`${generated?'generated part':'workspace file'}: real process exit after publication commit restores the same receipt and attachments without another effect`,async t=>{
 const f=await ready(t,generated),balance=f.modelBudgets.balancesForRun('alice',f.runId),crashed=child(f,'after_commit');
 assert.equal(crashed.status,73,crashed.stderr);assert.match(crashed.stdout,/boundary=after_commit;pid=\d+/);
 const receipt=JSON.parse(f.db.prepare('SELECT receipt_json FROM wb_task_finalizations').get().receipt_json);
 const events=f.db.prepare('SELECT count(*) n FROM ga_events').get().n,recovered=child(f,'recover');
 assert.equal(recovered.status,0,recovered.stderr);assert.deepEqual(JSON.parse(recovered.stdout.trim()).receipt,receipt);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,events);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_run_artifacts').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_native_completions').get().n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
 const snapshot=await f.app.inject({url:`/v1/conversations/${f.occurrence.conversation_id}/snapshot`,headers:{'x-user-id':'alice'}});
 assert.equal(snapshot.statusCode,200);assert.equal(snapshot.json().artifacts.length,generated?2:1);
 // The renderer source remains owned conversation history. Only the single
 // independently frozen delivery copy is linked to the final answer.
 assert.equal(snapshot.json().artifacts.filter(a=>a.artifact_id===f.artifactId).length,1);
 assert.deepEqual(snapshot.json().messages.filter(m=>m.role==='assistant')[0].attachments,[f.artifactId]);
 assert.equal(f.artifacts.download(f.artifactId,'alice',1).verified_content.toString(),'Reviewed process recovery bytes');
 assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),balance);
 t.diagnostic(JSON.stringify({boundary:'after_commit',exit:73,recovered_process_pid:JSON.parse(recovered.stdout.trim()).pid,artifact_count:1,assistant_count:1,duplicate_effects:0}));
});
}
