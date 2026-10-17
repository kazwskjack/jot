import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {workGrantFixture} from './work-grant-fixture.mjs';
import {WorkGrants} from '../../src/always-on/work-grants.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';

const Controller=(await import('../../src/always-on/work-admission.ts').catch(()=>({}))).WorkAdmissionController;
test('native work controller verifies bytes before original atomic enqueue',()=>assert.equal(typeof Controller,'function'));

async function fixture(t,options={}){
 const f=await workGrantFixture(t,options),grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'work-owner-command');
 const controller=(extra={})=>new Controller({db:f.db,tasks:f.tasks,policies:f.policies,workspace:f.manager,activity:f.activity,
  coordinator:f.coordinator,budgetPolicy:f.budget,maxAgeMs:5000,...extra});
 // The original fixture exposes the native adapter but constructs activity privately.
 const {ProjectActivityObserver}=await import('../../src/always-on/project-activity.ts');
 f.activity=new ProjectActivityObserver({db:f.db,workbench:f.workbench,native:f.native,maxAgeMs:5000});
 return {...f,grants,grant,controllerPlanning:f.controller(),controller};
}
test('verified work enqueues a distinct original occurrence with the original cumulative task scope',async t=>{
 const f=await fixture(t),charged=()=>f.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE state IN ('in_flight','settled','unknown')").get().n,before=charged();
 const result=await f.controller().admit('owner',f.scope,f.grant.grant_id,new AbortController().signal);
 assert.equal(result.admitted,true);assert.equal(result.execution_authorized,false);
 const occurrences=f.db.prepare('SELECT * FROM wb_task_occurrences ORDER BY rowid').all();assert.equal(occurrences.length,2);
 assert.equal(occurrences[1].task_id,occurrences[0].task_id);assert.notEqual(occurrences[1].conversation_id,occurrences[0].conversation_id);
 assert.equal(occurrences[1].trigger_key,'discovery-work:'+f.grant.grant_id);
 assert.equal(charged(),before);
 const scopes=JSON.parse(f.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE run_id=?').get(occurrences[1].run_id).scopes_json);
 assert.ok(scopes.includes(f.grant.task_budget_scope_id));
 const again=await f.controller().admit('owner',f.scope,f.grant.grant_id,new AbortController().signal);
 assert.deepEqual(again,result);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,2);
});
test('changed isolated bytes refuse work instead of recopying or accepting inspection as permission',async t=>{
 const f=await fixture(t),path=join(f.prepared.snapshot.isolated_root,'source.md');await writeFile(path,'unexpected isolated edit');
 await assert.rejects(()=>f.controller().admit('owner',f.scope,f.grant.grant_id,new AbortController().signal),/work_admission_snapshot_changed/);
 assert.equal(await readFile(path,'utf8'),'unexpected isolated edit');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,1);
});
test('original source metadata and bytes are verified after native observation and before enqueue',async t=>{
 const f=await fixture(t),original=f.native.observeNativeIdle;let changed=false;
 f.native.observeNativeIdle=async id=>{if(!changed){changed=true;f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'changed source',expected_version:1});}return original(id);};
 await assert.rejects(()=>f.controller().admit('owner',f.scope,f.grant.grant_id,new AbortController().signal),/source_record_changed|source_changed/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,1);
});
test('native busy and unavailable background capacity do not allocate work',async t=>{
 const f=await fixture(t),empty=new HarnessCoordinator(f.db,f.runs,f.events,Date.now,{maxBackgroundRuns:0,allowBackgroundRuns:true});
 assert.equal((await f.controller({coordinator:empty}).admit('owner',f.scope,f.grant.grant_id,new AbortController().signal)).reason,'BACKGROUND_CAPACITY');
 f.native.observeNativeIdle=async id=>({protocol:1,session_id:id,basis:'live',native_idle:'busy',reason:'RUNNING',observed_at:Date.now(),execution_authorized:false});
 assert.equal((await f.controller().admit('owner',f.scope,f.grant.grant_id,new AbortController().signal)).admitted,false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,1);
});
test('authority changed after byte inspection rolls back all original enqueue effects',async t=>{
 const f=await fixture(t),workspace={inspect:async(...args)=>{const result=await f.manager.inspect(...args);f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause-after-inspect');return result;}};
 await assert.rejects(()=>f.controller({workspace}).admit('owner',f.scope,f.grant.grant_id,new AbortController().signal),/work_grant|work_cycle/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,1);
});
test('one allowed cycle includes both its accepted planning and selected work occurrence',async t=>{
 const f=await fixture(t,{maxCycles:1}),result=await f.controller().admit('owner',f.scope,f.grant.grant_id,new AbortController().signal);
 assert.equal(result.admitted,true);assert.equal(f.db.prepare('SELECT runs_used FROM wb_persistent_tasks').get().runs_used,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,1);
});
test('planning cycle capacity counts original planning admissions rather than unrelated work occurrence counts',async t=>{
 const f=await fixture(t,{maxCycles:2});
 // The original task counter also includes work, while the discovery journal
 // remains the authoritative count of distinct planning cycles.
 f.db.prepare('UPDATE wb_persistent_tasks SET runs_used=runs_used+1').run();
 f.workbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'new external source',expected_version:1});
 assert.equal((await f.controllerPlanning.admit('owner',f.scope)).admitted,true);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,2);
});
test('completed owned chat input not yet collected into signals revokes the earlier selected work base',async t=>{
 const f=await fixture(t),chat=f.runs.enqueue(f.agent.conversation_id,'owner',{client_message_id:'new-owned-input',content:[{type:'text',text:'The current project requirement changed.'}]});
 f.workbench.bindRun('owner',f.agent.agent_id,chat.run_id,'chat');
 f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(chat.run_id);
 const before=f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n;
 await assert.rejects(()=>f.controller().admit('owner',f.scope,f.grant.grant_id,new AbortController().signal),/work_cycle_authority_revoked|work_grant_authority_revoked/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,before);
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_discovery_signals WHERE kind='user_input'").get().n,1);
});
