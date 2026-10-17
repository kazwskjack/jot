import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import test from 'node:test';import assert from 'node:assert/strict';import Fastify from 'fastify';import {readFile} from 'node:fs/promises';import {join} from 'node:path';
import {workGrantFixture} from './work-grant-fixture.mjs';import {WorkGrants} from '../../src/always-on/work-grants.ts';import {TrustedWorkRunWorkspaceResolver} from '../../src/always-on/work-run-workspace.ts';import {installIsolatedWorkFiles} from '../../src/always-on/isolated-work-file-schema.ts';import {registerWorkbenchExecution} from '../../src/workbench/execution.ts';
async function fixture(t,{configure=true}={}){
 const f=await workGrantFixture(t);installIsolatedWorkFiles(f.db);const grant=new WorkGrants(f.db,f.budget).authorize('owner',f.scope,f.cycle.cycle_id,f.input,'native-execution-select');
 const admission=f.tasks.enqueueDiscoveryWork('owner',grant.grant_id,()=>({activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:Date.now()})),claimed=f.coordinator.claimNext('native-execution-worker',60000);assert.equal(claimed.run_id,admission.run_id);f.coordinator.start(claimed);const lease={owner:claimed.owner,generation:claimed.generation};
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(admission.conversation_id,'owner','native-work-session','now','now');
 const resolver=new TrustedWorkRunWorkspaceResolver({db:f.db,workbench:f.workbench,policies:f.policies,workspace:f.manager}),app=Fastify();t.after(()=>app.close());app.setErrorHandler((error,request,reply)=>reply.status(400).send({error:error.message}));
 let resolves=0,collects=0,inspectionCurrent={inspection_sha256:'a'.repeat(64)},collected={inspection_sha256:'a'.repeat(64)};const nativeWork={resolver:{context:(...args)=>resolver.context(...args),resolveFiles:async(...args)=>{resolves++;assert.equal(f.db.isTransaction,false);return resolver.resolveFiles(...args);}},inspections:{collect:async()=>{collects++;assert.equal(f.db.isTransaction,false);return collected;},current:()=>{assert.equal(f.db.isTransaction,true);return inspectionCurrent;}}};
 const executionTasks=configure?new PersistentTaskService(f.db,f.workbench,{modelBudgetPolicy:f.budget,discoveryWorkOperations:{assertOperation:(run,op)=>{if(!resolver.context(run)||!['files.list','files.read','files.write','tasks.upsert','tasks.evidence','tasks.assess','tasks.assessment','tasks.observe','tasks.next','tasks.get','tasks.subtasks'].includes(op))throw Error('native_work_operation_forbidden');}}}):f.tasks;
 registerWorkbenchExecution(app,f.db,f.workbench,executionTasks,'test-work-11df6da2',f.budget.ledger,undefined,undefined,configure?nativeWork:undefined);
 const identity={run_id:admission.run_id,session_ref:'native-work-session',execution_lease:lease},tool=(operation,args={},extra={})=>app.inject({method:'POST',url:'/internal/v1/workbench/tool',headers:{authorization:'Bearer test-work-11df6da2'},payload:{...identity,call_id:operation,operation,arguments:args,...extra}});
 return {...f,app,grant,admission,lease,identity,resolver,tool,resolves:()=>resolves,collects:()=>collects,setInspectionCurrent:v=>{inspectionCurrent=v;},setCollected:v=>{collected=v;}};
}
test('authenticated native isolated file writes commit original proof and response once without shared mutation',async t=>{
 const f=await fixture(t),before=f.db.prepare('SELECT version,sha256 FROM wb_files WHERE path=?').get('source.md'),args={path:'source.md',content:'native isolated output',expected_version:0};
 const response=await f.tool('files.write',args);assert.equal(response.statusCode,200,response.body);const output=response.json();assert.equal(output.source,'isolated');assert.ok(output.execution_receipt.reference);assert.notEqual(output.receipt_id,output.execution_receipt.reference);
 assert.equal(await readFile(join(f.prepared.snapshot.isolated_root,'source.md'),'utf8'),args.content);assert.deepEqual(f.db.prepare('SELECT version,sha256 FROM wb_files WHERE path=?').get('source.md'),before);
 assert.deepEqual((await f.tool('files.write',args)).json(),output);assert.equal(f.resolves(),1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_isolated_file_execution_receipts WHERE receipt_id=?').get(output.execution_receipt.reference).n,1);
 const read=await f.tool('files.read',{path:'source.md'});assert.equal(read.statusCode,200,read.body);assert.equal(read.json().content,args.content);assert.ok(read.json().execution_receipt);
 const list=await f.tool('files.list');assert.equal(list.statusCode,200,list.body);assert.equal(list.json().source,'isolated');
 assert.notEqual((await f.tool('files.write',{...args,content:'changed'})).statusCode,200);assert.notEqual((await f.tool('web.read',{url:'https://example.invalid'})).statusCode,200);assert.notEqual((await f.tool('memory.save',{scope:'project',content:'forbidden'})).statusCode,200);
});
test('unconfigured work execution remains closed',async t=>{const f=await fixture(t,{configure:false});assert.notEqual((await f.tool('files.write',{path:'source.md',content:'blocked',expected_version:0})).statusCode,200);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_intents').get().n,0);const goal=await f.app.inject({method:'POST',url:'/internal/v1/workbench/goal-proposal',headers:{authorization:'Bearer test-work-11df6da2'},payload:{...f.identity,call_id:'default-complete',goal_id:'work-goal',goal_revision:1,intent:'complete',summary:'Unconfigured completion'}});assert.match(goal.body,/work_admission_execution_unavailable/);});

test('final native commit revalidates original response transaction and rolls proof back on response failure',async t=>{
 const f=await fixture(t),before=f.db.prepare('SELECT count(*) n FROM wb_task_execution_receipts').get().n;
 f.db.exec("CREATE TRIGGER fail_native_response BEFORE INSERT ON wb_tool_receipts WHEN NEW.call_id='files.write' BEGIN SELECT RAISE(ABORT,'synthetic_response_failure'); END");
 const response=await f.tool('files.write',{path:'source.md',content:'uncommitted physical replacement',expected_version:0});assert.equal(response.statusCode,400);assert.match(response.body,/synthetic_response_failure/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_execution_receipts').get().n,before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_results').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_pending').get().n,1);
 const replay=await f.tool('files.write',{path:'source.md',content:'uncommitted physical replacement',expected_version:0});assert.equal(replay.statusCode,400);assert.match(replay.body,/uncertain/);
});
test('owner session and stale captured lease cannot enter isolated IO',async t=>{
 const f=await fixture(t),args={path:'source.md',content:'blocked',expected_version:0};
 assert.notEqual((await f.tool('files.write',args,{session_ref:'foreign'})).statusCode,200);assert.notEqual((await f.tool('files.write',args,{execution_lease:{...f.lease,generation:f.lease.generation+1}})).statusCode,200);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_intents').get().n,0);
});

test('complete proposal collects outside SQL then freezes current original inspection and replays original response',async t=>{
 const f=await fixture(t),write=await f.tool('files.write',{path:'source.md',content:'completed native bytes',expected_version:0});assert.equal(write.statusCode,200,write.body);
 for(const existing of f.tasks.subtasks('owner',f.admission.task_id).items){const step=await f.tool('tasks.upsert',{subtask_id:existing.subtask_id,expected_version:existing.version,status:'completed',evidence:[write.json().execution_receipt]},{call_id:'complete-step-'+existing.subtask_id});assert.equal(step.statusCode,200,step.body);}
 const post=(path,payload)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/'+path,headers:{authorization:'Bearer test-work-11df6da2'},payload:{...f.identity,...payload}});
 assert.equal((await post('goal-binding',{action:'save',goal_id:'native-work-goal',goal_revision:1})).statusCode,200);
 const input={call_id:'complete-native',goal_id:'native-work-goal',goal_revision:1,intent:'complete',summary:'Ready for owner review'};
 const result=await post('goal-proposal',input);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().proposal.accepted,true);assert.equal(f.collects(),1);
 const saved=JSON.parse(f.db.prepare('SELECT snapshot_json FROM wb_task_goal_proposals WHERE run_id=?').get(f.admission.run_id).snapshot_json);assert.deepEqual(saved.isolated_work_evidence,{inspection_sha256:'a'.repeat(64)});
 assert.deepEqual((await post('goal-proposal',input)).json(),result.json());assert.equal(f.collects(),1);
});
test('configured native work adapter preserves ordinary workspace requests without a work lease',async t=>{
 const f=await fixture(t),run=f.runs.enqueue(f.agent.conversation_id,'owner',{client_message_id:'ordinary-native-config',content:[{type:'text',text:'ordinary'}]});f.workbench.bindRun('owner',f.agent.agent_id,run.run_id,'chat');
 const session=f.db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(f.agent.conversation_id).session_id;
 const response=await f.app.inject({method:'POST',url:'/internal/v1/workbench/tool',headers:{authorization:'Bearer test-work-11df6da2'},payload:{run_id:run.run_id,session_ref:session,operation:'files.list',arguments:{}}});assert.equal(response.statusCode,200,response.body);assert.equal(f.resolves(),0);
});
test('authenticated Host context receives exact original work marker, isolated cwd and selected objective',async t=>{
 const f=await fixture(t),response=await f.app.inject({method:'POST',url:'/internal/v1/workbench/guard',headers:{authorization:'Bearer test-work-11df6da2'},payload:f.identity});assert.equal(response.statusCode,200,response.body);const context=response.json().context,original=f.resolver.context(f.admission.run_id,f.lease);
 assert.deepEqual(context.work_binding,original.work_binding);assert.deepEqual(context.native_workspace,original.native_workspace);assert.equal(context.task_binding.objective,original.objective);assert.notEqual(context.task_binding.objective,f.tasks.get('owner',f.admission.task_id).objective);
});
test('missing trusted native work adapter refuses Host context instead of selecting ordinary workspace',async t=>{
 const f=await fixture(t,{configure:false}),response=await f.app.inject({method:'POST',url:'/internal/v1/workbench/guard',headers:{authorization:'Bearer test-work-11df6da2'},payload:f.identity});assert.equal(response.statusCode,400);assert.match(response.body,/work_admission_execution_unavailable/);
});
import {NativeTaskIntents} from '../../src/workbench/native-task-intents.ts';import {NativeChildReservations} from '../../src/workbench/native-child-reservations.ts';import {TaskCollaborationService} from '../../src/workbench/task-collaboration.ts';import {TaskDelegationService} from '../../src/workbench/task-delegation.ts';
test('native members of original isolated work never fall back to shared workspace bytes',async t=>{
 const f=await fixture(t),member=f.workbench.createAgent('owner',{name:'Native isolated member',workspace_id:'ws',project_id:f.scope.project_id}),team=f.workbench.createTeam('owner',{name:'Native work team',workspace_id:'ws',project_id:f.scope.project_id,member_ids:[f.scope.agent_id,member.agent_id]}),collaboration=new TaskCollaborationService(f.db,f.workbench,f.tasks,new TaskDelegationService(f.db,f.workbench,f.tasks));
 collaboration.save('owner',f.admission.task_id,{expected_version:0,enabled:true,team_id:team.team_id,member_ids:[member.agent_id],max_delegations:1,max_active:1});const step=f.tasks.subtasks('owner',f.admission.task_id).items[0],intents=new NativeTaskIntents(f.db,f.workbench,f.tasks,collaboration);
 intents.prepare('owner',f.admission.run_id,{request_id:'native-work-member',subtask_id:step.subtask_id,expected_subtask_version:step.version,recipient_agent_id:member.agent_id});
 const reservation=new NativeChildReservations(f.db,collaboration,intents).reserve({...f.identity,request_id:'native-work-member',child_session_ref:'native-isolated-member-session',role_ref:member.agent_id,expected_policy_version:1}),child=f.workbench.prepareNativeChild('owner',reservation.reservation_id);
 const before=f.db.prepare('SELECT version,sha256 FROM wb_files WHERE path=?').get('source.md'),response=await f.tool('files.write',{path:'source.md',content:'must never enter shared source',expected_version:1},{run_id:child.run_id,session_ref:child.session_ref});assert.notEqual(response.statusCode,200);assert.deepEqual(f.db.prepare('SELECT version,sha256 FROM wb_files WHERE path=?').get('source.md'),before);
});

test('a missing host inspection cannot silently produce an uninspected complete proposal',async t=>{
 const f=await fixture(t);f.setCollected(undefined);const response=await f.app.inject({method:'POST',url:'/internal/v1/workbench/goal-proposal',headers:{authorization:'Bearer test-work-11df6da2'},payload:{...f.identity,call_id:'missing-inspection',goal_id:'work-goal',goal_revision:1,intent:'complete',summary:'Missing host receipt'}});assert.equal(response.statusCode,400);assert.match(response.body,/task_completion_work_inspection_required/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_goal_proposals WHERE run_id=?').get(f.admission.run_id).n,0);
});
