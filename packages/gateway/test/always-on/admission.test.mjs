import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {openProductDatabase} from '../../src/db/database.ts';import {EventStore} from '../../src/events/event-store.ts';import {RunRepository} from '../../src/runs/repository.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';import {WorkbenchBudgetPolicy} from '../../src/workbench/model-budget-policy.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {DiscoveryPolicies} from '../../src/always-on/discovery-policy.ts';import {ProjectActivityObserver} from '../../src/always-on/project-activity.ts';
import Fastify from 'fastify';import {registerWorkbenchExecution} from '../../src/workbench/execution.ts';import {TaskBudgetService} from '../../src/workbench/budget-public.ts';
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const Controller=(await import('../../src/always-on/admission.ts').catch(()=>({}))).DiscoveryAdmissionController;
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jot-discovery-admission-')),db=openProductDatabase(join(root,'db.sqlite')),events=new EventStore(db),runs=new RunRepository(db,events);
 const limits={tokens:5000,nano_usd:50000,model_calls:50},route={provider:'fixture',model:'bounded',revision:'rates-1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}};
 const budget=new WorkbenchBudgetPolicy(db,{revision:1,admission_route:{provider:'fixture',model:'bounded'},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(k=>[k,{...limits}]))});
 const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(root,'workspace'),modelBudgetPolicy:budget}),tasks=new PersistentTaskService(db,workbench,{modelBudgetPolicy:budget});
 const policies=new DiscoveryPolicies(db,{onChange:(owner,receipt,event)=>tasks.synchronizeDiscoveryPolicy(owner,receipt.policy_id,event)}),agent=workbench.createAgent('owner',{name:'Synthetic discovery'}),scope={project_id:agent.project_id,workspace_id:'ws',agent_id:agent.agent_id};
 workbench.projectRoot('owner','ws',agent.project_id);db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(agent.conversation_id,'owner','synthetic-session','now','now');
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 policies.save('owner',scope,{expected_version:0,expected_role_version:1,expected_role_epoch:1,mode:'discover_only',cooldown_ms:0,recent_input_ms:0,max_cycles:null},'save');const enabled=policies.control('owner',scope,{action:'enable',expected_version:1,expected_role_version:1,expected_role_epoch:1},'enable');
 const coordinator=new HarnessCoordinator(db,runs,events),native={nativeIdleObservationReadiness:async()=>({protocol:1,ready:true,execution_authorized:false}),observeNativeIdle:async id=>({protocol:1,session_id:id,basis:'live',native_idle:'idle',reason:null,observed_at:Date.now(),execution_authorized:false})};
 const activity=new ProjectActivityObserver({db,workbench,native,maxAgeMs:5000}),controller=(extra={})=>new Controller({db,workbench,tasks,policies,coordinator,activity,budgetPolicy:budget,maxAgeMs:5000,...extra});
 const file=()=>workbench.writeFile('owner','ws',{project_id:agent.project_id,path:'source.md',content:'PRIVATE fixture',expected_version:0});
 return{db,workbench,tasks,policies,scope,enabled,agent,native,controller,file,coordinator,budget,runs,events,root};
}
test('discovery original occurrence controller is available',()=>assert.equal(typeof Controller,'function'));
test('coalesced sources reserve one original occurrence and inherit original task budget without a model call',async t=>{
 const f=fixture(t);f.file();const r=await f.controller().admit('owner',f.scope);assert.equal(r.admitted,true);assert.equal(r.execution_authorized,false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE state<>'reserved'").get().n,0);
 const row=f.db.prepare('SELECT * FROM wb_discovery_admissions').get(),task=f.tasks.list('owner').items[0];assert.equal(row.task_id,task.task_id);assert.equal(row.signal_revision,1);assert.equal(task.runs_used,1);
 assert.equal((await f.controller().admit('owner',f.scope)).admitted,false);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('unknown native idle and a paused policy do not enqueue',async t=>{
 const f=fixture(t);f.native.observeNativeIdle=async id=>({protocol:1,session_id:id,basis:'live',native_idle:'unknown',reason:'STATE_UNAVAILABLE',observed_at:Date.now(),execution_authorized:false});assert.equal((await f.controller().admit('owner',f.scope)).admitted,false);
 f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause');assert.equal((await f.controller().admit('owner',f.scope)).reason,'POLICY_DISABLED');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
test('work mode cannot borrow discovery planning authority before isolated workspace integration',async t=>{
 const f=fixture(t);f.policies.save('owner',f.scope,{expected_version:2,expected_role_version:1,expected_role_epoch:1,mode:'discover_and_work',cooldown_ms:0,recent_input_ms:0,max_cycles:null},'work-mode');
 assert.equal((await f.controller().admit('owner',f.scope)).reason,'ISOLATED_WORK_CYCLE_REQUIRED');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
test('source changes during native observation cannot be admitted under the earlier signal batch',async t=>{
 const f=fixture(t),observe=f.native.observeNativeIdle;f.native.observeNativeIdle=async id=>{f.file();return observe(id);};
 assert.equal((await f.controller().admit('owner',f.scope)).reason,'SOURCE_CHANGED');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
test('caller scope mutation during observation cannot retarget original admission',async t=>{
 const f=fixture(t),observe=f.native.observeNativeIdle;f.native.observeNativeIdle=async id=>{f.scope.project_id='not-the-original-project';return observe(id);};
 const result=await f.controller().admit('owner',f.scope);assert.equal(result.admitted,true);
 assert.equal(f.db.prepare('SELECT project_id FROM wb_discovery_task_bindings').get().project_id,f.agent.project_id);
});
test('competing controllers coalesce the same journal head to one original queue admission',async t=>{
 const f=fixture(t);f.file();const results=await Promise.all([f.controller().admit('owner',f.scope),f.controller().admit('owner',f.scope)]);
 assert.equal(results.filter(r=>r.admitted).length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});
test('independent fixture processes reserve the same journal head exactly once',{timeout:40000},async t=>{
 const f=fixture(t);f.file();const children=[];
 async function start(){const child=spawn(process.execPath,[fileURLToPath(new URL('./admission-worker.mjs',import.meta.url)),join(f.root,'db.sqlite'),f.root,JSON.stringify(f.scope)],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.push(child);const messages=[],done=new Promise(resolve=>child.once('exit',resolve));child.on('message',m=>messages.push(m));const deadline=Date.now()+15000;while(!messages.some(m=>m.ready)&&child.exitCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(messages.some(m=>m.ready));return{child,messages,done};}
 try{const a=await start(),b=await start();a.child.send({go:true});b.child.send({go:true});assert.deepEqual(await Promise.all([a.done,b.done]),[0,0]);assert.equal([...a.messages,...b.messages].filter(m=>m.admitted===true).length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);}finally{for(const child of children)if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}}
});
test('immutable reservation history cannot be replaced or detached from its original occurrence',async t=>{
 const f=fixture(t);await f.controller().admit('owner',f.scope);
 for(const sql of ['DELETE FROM wb_discovery_admissions','UPDATE wb_discovery_admissions SET signal_revision=99','INSERT OR REPLACE INTO wb_discovery_admissions SELECT * FROM wb_discovery_admissions'])assert.throws(()=>f.db.exec(sql),/discovery_admission_immutable|discovery_admission_invalid/);
 assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('original exhausted budget and original zero background capacity refuse queue creation',async t=>{
 const f=fixture(t),empty=new HarnessCoordinator(f.db,f.runs,f.events,Date.now,{maxBackgroundRuns:0,allowBackgroundRuns:true});
 assert.equal((await f.controller({coordinator:empty}).admit('owner',f.scope)).reason,'BACKGROUND_CAPACITY');
 const task=f.tasks.list('owner').items[0];new TaskBudgetService(f.db,f.budget).update('owner',task.task_id,{expected_version:0,limits:{tokens:0,nano_usd:0,model_calls:0}});
 assert.equal((await f.controller().admit('owner',f.scope)).reason,'BUDGET_BLOCKED');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
test('real authenticated workspace transport rejects a discovery write before any file mutation',async t=>{
 const f=fixture(t);f.file();await f.controller().admit('owner',f.scope);const occurrence=f.db.prepare('SELECT * FROM wb_task_occurrences').get(),lease=f.coordinator.claimNext('fixture-worker',30000);f.coordinator.start(lease);
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(occurrence.conversation_id,'owner','admission-session','now','now');
 const app=Fastify();app.setErrorHandler((error,request,reply)=>reply.code(409).send({error:error.message}));registerWorkbenchExecution(app,f.db,f.workbench,f.tasks,'test-954bc2dd46044b5f',f.budget.ledger);t.after(()=>app.close());
 const input={run_id:occurrence.run_id,session_ref:'admission-session',execution_lease:{owner:'fixture-worker',generation:lease.generation},call_id:'fixture-write',operation:'files.write',arguments:{path:'forbidden.md',content:'Must not be written',expected_version:0}};
 const response=await app.inject({method:'POST',url:'/internal/v1/workbench/tool',headers:{authorization:'Bearer test-954bc2dd46044b5f'},payload:input});assert.equal(response.statusCode,409);assert.equal(response.json().error,'discovery_planning_read_only');assert.equal(f.db.prepare("SELECT count(*) n FROM wb_files WHERE path='forbidden.md'").get().n,0);
 const read=await app.inject({method:'POST',url:'/internal/v1/workbench/tool',headers:{authorization:'Bearer test-954bc2dd46044b5f'},payload:{...input,call_id:'fixture-read',operation:'files.read',arguments:{path:'source.md'}}});assert.equal(read.statusCode,200,read.body);
});
test('a policy change during native observation is refused inside original admission transaction',async t=>{
 const f=fixture(t),observe=f.native.observeNativeIdle;f.native.observeNativeIdle=async id=>{f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause-during-observation');return observe(id);};
 assert.equal((await f.controller().admit('owner',f.scope)).admitted,false);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
test('failed original occurrence commit rolls back reservation, queue, conversation and original budget allocation',async t=>{
 const f=fixture(t);f.file();const conversations=f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n;
 f.db.exec("CREATE TRIGGER synthetic_admission_failure BEFORE INSERT ON wb_task_occurrences BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END;");
 await assert.rejects(()=>f.controller().admit('owner',f.scope),/synthetic_failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n,conversations);
 f.db.exec('DROP TRIGGER synthetic_admission_failure');assert.equal((await f.controller().admit('owner',f.scope)).admitted,true);
});
test('planning admission permits scoped reads and denies mutation; policy stop revokes original run',async t=>{
 const f=fixture(t);const r=await f.controller().admit('owner',f.scope),row=f.db.prepare('SELECT run_id FROM wb_task_occurrences').get();assert.equal(r.admitted,true);
 assert.doesNotThrow(()=>f.tasks.assertDiscoveryOperation(row.run_id,'files.read'));for(const operation of ['files.write','messages.send','memory.save','tasks.delegate'])assert.throws(()=>f.tasks.assertDiscoveryOperation(row.run_id,operation),/discovery_planning_read_only/);
 f.policies.control('owner',f.scope,{action:'stop',expected_version:2},'stop');assert.throws(()=>f.tasks.assertRunActive(row.run_id),/task_generation_revoked|discovery_authority_revoked/);
});
