import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {HarnessWorker} from '../../src/harness/worker.ts';
import {OfficialSessionRunner} from '../../src/harness/official-session-runner.ts';

function fixture(t, {marker=true,continuation=false}={}) {
 const db=openProductDatabase(':memory:');t.after(()=>db.close());
 const events=new EventStore(db),runs=new RunRepository(db,events),now=new Date().toISOString();
 db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('work-chat','owner','ws','Work','{}',1,now,now);
 const receipt=runs.enqueue('work-chat','owner',{client_message_id:'input',content:[{type:'text',text:'Old planning objective; cwd=/untrusted'}]});
 if(continuation){
  db.prepare(`INSERT INTO ga_runs(id,conversation_id,input_message_id,status,checkpoint_id,created_at,updated_at)
    SELECT 'original-work-run',conversation_id,input_message_id,'interrupted','work-checkpoint',created_at,updated_at FROM ga_runs WHERE id=?`).run(receipt.run_id);
  db.prepare("UPDATE ga_runs SET continuation_of='original-work-run',checkpoint_id='work-checkpoint' WHERE id=?").run(receipt.run_id);
  db.prepare('INSERT INTO ga_session_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?)').run('work-checkpoint','original-work-run','work-chat','work-session',5,4,'work-goal',2,'a'.repeat(64),now);
  db.prepare('INSERT INTO ga_interactions(id,conversation_id,run_id,kind,status,version,request_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run('work-question','work-chat','original-work-run','question','answered',2,'{}',now);
  db.prepare('INSERT INTO wb_task_wait_interactions VALUES(?,?,?,?,?,?,?)').run('work-question','original-work-run','work-proposal','work-checkpoint',1,'task_input',now);
  db.prepare('INSERT INTO wb_task_wait_responses VALUES(?,?,?,?)').run('work-question',receipt.run_id,JSON.stringify({kind:'user_input',text:'Use the approved blue variant'}),now);
 }
 // The real Worker consumes the original task lineage view. The fixture isolates
 // its native-boundary contract from grant/admission filesystem preparation.
 db.exec(`CREATE TABLE wb_task_run_occurrences(run_id TEXT,root_run_id TEXT,task_id TEXT,occurrence_id TEXT,conversation_id TEXT,trigger_key TEXT);
 CREATE TABLE wb_persistent_tasks(task_id TEXT,owner_id TEXT);`);
 db.prepare('INSERT INTO wb_task_run_occurrences VALUES(?,?,?,?,?,?)').run(receipt.run_id,continuation?'original-work-run':receipt.run_id,'task','work-occurrence','work-chat','discovery-work:grant');
 db.prepare('INSERT INTO wb_persistent_tasks VALUES(?,?)').run('task','owner');
 db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run('work-chat','owner','work-session',now,now);
 const binding={kind:'isolated_work',runId:receipt.run_id,originalRunId:continuation?'original-work-run':receipt.run_id,ownerId:'owner',conversationId:'work-chat',taskId:'task',occurrenceId:'work-occurrence',sessionRef:'work-session',cwd:resolve(tmpdir(),'trusted-work'),objective:'Implement exact frozen selected plan'};
 const context={kind:'task',...(marker?{work_binding:{kind:'isolated_work',original_run_id:binding.originalRunId,occurrence_id:'work-occurrence'}}:{})};
 const options={workerId:'test',leaseMs:30000,sessionResolver:()=> 'work-session',executionGuard:{assertRunActive(){},contextForRun:()=>context}};
 return {db,runs,receipt,binding,options,coordinator:new HarnessCoordinator(db,runs,events)};
}
const stopped={observed:true,completed:false,reason_code:'TEST_STOP',runtime_status:'not_required'};
for(const marker of [true,false])test(`bound work missing trusted resolver refuses native dispatch (marker=${marker})`,async t=>{
 const f=fixture(t,{marker});let called=0;
 await new HarnessWorker(f.db,f.coordinator,{async run(){called++;return stopped;}},f.options).processNext();
 assert.equal(called,0);assert.equal(f.runs.get(f.receipt.run_id,'owner').status,'interrupted');
});
for(const field of ['runId','originalRunId','ownerId','conversationId','taskId','occurrenceId','sessionRef'])test(`work resolver rejects substituted ${field}`,async t=>{
 const f=fixture(t);let called=0;
 await new HarnessWorker(f.db,f.coordinator,{async run(){called++;return stopped;}},{...f.options,workRunWorkspaceResolver:{resolve:()=>({...f.binding,[field]:'substituted'})}}).processNext();
 assert.equal(called,0);
});
for(const continuation of [false,true])test(`trusted frozen workspace reaches original Runner (continuation=${continuation})`,async t=>{
 const f=fixture(t,{continuation});let saved;
 await new HarnessWorker(f.db,f.coordinator,{async run(input){saved=input;return stopped;}},{...f.options,workRunWorkspaceResolver:{resolve:()=>f.binding}}).processNext();
 assert.ok(saved?.trustedWorkWorkspace);assert.equal(saved.requiresWorkWorkspace,true);
 if(continuation){assert.match(saved.message,/持久 Session/);assert.match(saved.message,/Use the approved blue variant/);assert.notEqual(saved.message,f.binding.objective);}
 else assert.equal(saved.message,f.binding.objective);
 assert.equal(saved.trustedWorkWorkspace.objective,f.binding.objective);assert.equal(saved.sessionRef,'work-session');assert.ok(Object.isFrozen(saved.trustedWorkWorkspace));
 let cwd,session,workProtocol;
 const runner=new OfficialSessionRunner({async create(id,path,_preset,_signal,_run,_lease,protocol){session=id;cwd=path;workProtocol=protocol;return {};},async *follow(){throw Error('test_end_after_create');}}, {cwd:resolve(tmpdir(),'global-fallback'),agentPreset:'general'});
 await assert.rejects(runner.run(saved),/test_end_after_create/);
 assert.equal(cwd,f.binding.cwd);assert.equal(session,'work-session');assert.deepEqual(workProtocol,{protocol:1});
 for(const changed of [{trustedWorkWorkspace:{...saved.trustedWorkWorkspace,cwd:resolve(tmpdir(),'evil')}},{message:'substituted objective'},{sessionRef:'planning-session'},{workbenchExecutionLease:{owner:'other-worker',generation:100}}]){
  cwd=undefined;await assert.rejects(runner.run({...saved,...changed}),/work_workspace/);assert.equal(cwd,undefined);
 }
});
for(const workspace of [undefined,{kind:'isolated_work',cwd:resolve(tmpdir(),'forged')}])test('Runner refuses missing or untrusted workspace before create',async()=>{
 let created=0;const runner=new OfficialSessionRunner({async create(){created++;return {};}},{cwd:resolve(tmpdir(),'fallback'),agentPreset:'general'});
 await assert.rejects(runner.run({enabled:true,taskRequestId:'work-run',message:'Selected objective',sessionRef:'work-session',deferCompletionProbe:true,requiresWorkWorkspace:true,trustedWorkWorkspace:workspace}),/work_workspace/);
 assert.equal(created,0);
});
for(const change of [null,{cwd:'relative/work'},{cwd:resolve(tmpdir(),'bad')+'\0path'},{objective:''},{objective:'   '}])test('missing or malformed trusted journal result refuses dispatch',async t=>{
 const f=fixture(t);let calls=0;
 await new HarnessWorker(f.db,f.coordinator,{async run(){calls++;return stopped;}},{...f.options,workRunWorkspaceResolver:{resolve:()=>change===null?null:{...f.binding,...change}}}).processNext();
 assert.equal(calls,0);
});
for(const change of ['saved_session','owner','lineage','marker','lease'])test(`authority change while resolving workspace refuses dispatch: ${change}`,async t=>{
 const f=fixture(t);let calls=0;
 const resolver={async resolve(){await Promise.resolve();
  if(change==='saved_session')f.db.prepare("UPDATE ga_harness_session_bindings SET session_id='replaced-session'").run();
  if(change==='owner')f.db.prepare("UPDATE ga_conversations SET owner_id='other-owner'").run();
  if(change==='lineage')f.db.prepare("UPDATE wb_task_run_occurrences SET occurrence_id='replaced-occurrence'").run();
  if(change==='marker')f.options.executionGuard.contextForRun=()=>({kind:'task'});
  if(change==='lease')f.db.prepare('UPDATE ga_worker_leases SET generation=generation+1').run();
  return f.binding;
 }};
 const attempt=new HarnessWorker(f.db,f.coordinator,{async run(){calls++;return stopped;}},{...f.options,workRunWorkspaceResolver:resolver}).processNext();
 if(change==='lease')await assert.rejects(attempt,/worker_fence_rejected/);else await attempt;
 assert.equal(calls,0);
});
test('work binding absent from server context cannot be supplied by a resolver alone',async t=>{
 const f=fixture(t,{marker:false});let calls=0;
 await new HarnessWorker(f.db,f.coordinator,{async run(){calls++;return stopped;}},{...f.options,workRunWorkspaceResolver:{resolve:()=>f.binding}}).processNext();
 assert.equal(calls,0);
});
