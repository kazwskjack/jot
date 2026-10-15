import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture} from './task-wait-fixture.mjs';
import {buildServer} from '../../src/server.ts';
import {TaskCollaborationService} from '../../src/workbench/task-collaboration.ts';import {TaskDelegationService} from '../../src/workbench/task-delegation.ts';
import {createTaskHandoffHost} from '../../src/workbench/task-handoff-host.ts';
import {NativeChildReservations} from '../../src/workbench/native-child-reservations.ts';
import {openProductDatabase} from '../../src/db/database.ts';
async function setup(t){const f=await fixture(t);const member=f.workbench.createAgent('alice',{name:'Reviewer',workspace_id:'ws',project_id:f.a.project_id});const team=f.workbench.createTeam('alice',{name:'Team',workspace_id:'ws',project_id:f.a.project_id,member_ids:[f.a.agent_id,member.agent_id]});const collaboration=new TaskCollaborationService(f.db,f.workbench,f.persistentTasks,new TaskDelegationService(f.db,f.workbench,f.persistentTasks));collaboration.save('alice',f.task.task_id,{expected_version:0,enabled:true,team_id:team.team_id,member_ids:[member.agent_id],max_delegations:2,max_active:2});f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.runId);f.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at').run(f.runId,'handoff-worker',1,String(Date.now()+60000),'now');const host=createTaskHandoffHost({db:f.db,workbench:f.workbench,tasks:f.persistentTasks,collaboration,ledger:f.modelBudgets,owner:'alice',rootRun:f.runId,policyVersion:1,executionLease:{owner:'handoff-worker',generation:1},model:{provider:'fixture',model:'bounded'}});return {...f,host,member,collaboration};}
const identityFor=f=>({run_id:f.runId,session_ref:'session-fixture',execution_lease:{owner:'handoff-worker',generation:1}});
const handoffRequest=(f,action,request={},extra={})=>f.app.inject({method:'POST',url:'/internal/v1/workbench/handoff',headers:{authorization:'Bearer '+f.fixtureConfig.internalChannelToken},payload:{...identityFor(f),action,request,expected_policy_version:1,route:{provider:'fixture',model:'bounded'},...extra}});
const internalRequest=(f,path,payload)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/'+path,headers:{authorization:'Bearer '+f.fixtureConfig.internalChannelToken},payload});
function prepareNativeChild(f,session,requestId){const reservation=new NativeChildReservations(f.db,f.collaboration).reserve({run_id:f.runId,session_ref:'session-fixture',child_session_ref:session,role_ref:f.member.agent_id,request_id:requestId,expected_policy_version:1,execution_lease:identityFor(f).execution_lease});return f.workbench.prepareNativeChild('alice',reservation.reservation_id);}
const closureProof=session=>({protocol:1,session_ref:session,parent_session_ref:'session-fixture',seq_exclusive:10,turn_end_seq:9,log_sha256:'a'.repeat(64),driver_nonresident:true,inbox_pending:0});
const closeNativeChild=async(f,child)=>internalRequest(f,'native-child-close',{run_id:child.run_id,session_ref:child.session_ref,proof:closureProof(child.session_ref)});
async function transferToChild(f,child){const started=await handoffRequest(f,'start',{request_id:'recovery-start',max_hops:2});assert.equal(started.statusCode,200,started.body);return handoffRequest(f,'transfer',{request_id:'recovery-transfer',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id,execution_run_id:child.run_id,execution_session_ref:child.session_ref});}
test('host binds original role policy, root run and budget without allocating a child',async t=>{const f=await setup(t);const balances=f.modelBudgets.balancesForRun('alice',f.runId);f.host.start({request_id:'start',max_hops:2});const next=f.host.transfer({request_id:'transfer',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id});assert.equal(next.controller,f.member.agent_id);assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),balances);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_child_reservations').get().n,0);});

test('authenticated handoff transport binds the original lead and atomically rejects a bad receiver',async t=>{
 const f=await setup(t),identity={run_id:f.runId,session_ref:'session-fixture',execution_lease:{owner:'handoff-worker',generation:1}};
 const invoke=(action,request={},extra={},auth=true)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/handoff',headers:auth?{authorization:'Bearer '+f.fixtureConfig.internalChannelToken}:{},payload:{...identity,action,expected_policy_version:1,route:{provider:'fixture',model:'bounded'},request,...extra}});
 const balances=f.modelBudgets.balancesForRun('alice',f.runId);
 assert.notEqual((await invoke('start',{request_id:'start',max_hops:2},{},false)).statusCode,200);
 const started=await invoke('start',{request_id:'start',max_hops:2});assert.equal(started.statusCode,200,started.body);assert.equal(started.json().state.revision,1);
 assert.equal(f.host.assertExecution({expected_revision:1,run_id:f.runId,session_ref:'session-fixture'}).run_id,f.runId);
 assert.equal((await invoke('start',{request_id:'start',max_hops:2})).json().state.revision,1);
 const bad=await invoke('transfer',{request_id:'bad-receiver',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id,execution_run_id:f.runId,execution_session_ref:'session-fixture'});assert.notEqual(bad.statusCode,200);assert.equal(f.host.get().revision,1);assert.equal(f.db.prepare("SELECT count(*) n FROM wb_task_handoff_requests WHERE request_id='bad-receiver'").get().n,0);
 assert.notEqual((await invoke('get',{}, {owner_id:'mallory'})).statusCode,200);
 assert.notEqual((await invoke('get',{}, {session_ref:'foreign-session'})).statusCode,200);
 assert.notEqual((await invoke('get',{}, {execution_lease:{owner:'handoff-worker',generation:2}})).statusCode,200);
 assert.notEqual((await invoke('get',{execution_lease:{owner:'handoff-worker',generation:1}})).statusCode,200);
 assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),balances);
 f.modelBudgets.reserve('alice',f.runId,{attempt_id:'handoff-api-pending',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',f.runId,'handoff-api-pending');
 const pending=await invoke('transfer',{request_id:'pending',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id,execution_run_id:f.runId,execution_session_ref:'session-fixture'});assert.equal(pending.statusCode,409);assert.equal(pending.json().error.code,'HANDOFF_USAGE_UNRESOLVED');assert.equal(f.host.get().revision,1);
 assert.equal((await invoke('stop',{request_id:'stop',expected_revision:1})).json().state.phase,'stopped');
 assert.equal(f.db.prepare("SELECT state FROM wb_model_budget_attempts WHERE attempt_id='handoff-api-pending'").get().state,'in_flight');
 assert.equal((await invoke('get')).json().state.phase,'stopped');
});

test('handoff HTTP transfer and replay bind one exact native execution and return final control to the lead',async t=>{
 const f=await setup(t),identity={run_id:f.runId,session_ref:'session-fixture',execution_lease:{owner:'handoff-worker',generation:1}};
 const invoke=(action,request)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/handoff',headers:{authorization:'Bearer '+f.fixtureConfig.internalChannelToken},payload:{...identity,action,request,expected_policy_version:1,route:{provider:'fixture',model:'bounded'}}});
 const reservations=new NativeChildReservations(f.db,f.collaboration),reserve=(id)=>f.workbench.prepareNativeChild('alice',reservations.reserve({...identity,child_session_ref:id,role_ref:f.member.agent_id,request_id:'spawn-'+id,expected_policy_version:1}).reservation_id);
 const child=reserve('http-child-one'),other=reserve('http-child-two');
 assert.equal((await invoke('start',{request_id:'start',max_hops:2})).statusCode,200);
 const request={request_id:'transfer',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id,execution_run_id:child.run_id,execution_session_ref:'http-child-one'};
 const transferred=await invoke('transfer',request);assert.equal(transferred.statusCode,200,transferred.body);assert.equal(transferred.json().state.controller,f.member.agent_id);
 assert.deepEqual((await invoke('transfer',request)).json(),transferred.json());
 assert.notEqual((await invoke('transfer',{...request,execution_run_id:other.run_id,execution_session_ref:'http-child-two'})).statusCode,200);assert.equal(f.host.get().revision,2);
 const guard=(run_id,session_ref)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/guard',headers:{authorization:'Bearer '+f.fixtureConfig.internalChannelToken},payload:{run_id,session_ref,tool_name:'jot_workspace'}});
 assert.notEqual((await guard(f.runId,'session-fixture')).statusCode,200);assert.equal((await guard(child.run_id,'http-child-one')).statusCode,200);assert.notEqual((await guard(other.run_id,'http-child-two')).statusCode,200);
 const returned=await invoke('transfer',{request_id:'return',expected_revision:2,from:f.member.agent_id,to:f.a.agent_id,execution_run_id:f.runId,execution_session_ref:'session-fixture'});assert.equal(returned.statusCode,200,returned.body);assert.equal(returned.json().state.phase,'returned');
 assert.equal((await guard(f.runId,'session-fixture')).statusCode,200);assert.notEqual((await guard(child.run_id,'http-child-one')).statusCode,200);
});

test('authorized return recovery reports none before start and while the lead controls the task',async t=>{
 const f=await setup(t),identity={run_id:f.runId,session_ref:'session-fixture',execution_lease:{owner:'handoff-worker',generation:1}};
 const invoke=(action,request={})=>f.app.inject({method:'POST',url:'/internal/v1/workbench/handoff',headers:{authorization:'Bearer '+f.fixtureConfig.internalChannelToken},payload:{...identity,action,request,expected_policy_version:1,route:{provider:'fixture',model:'bounded'}}});
 const before=await invoke('recover_return');assert.equal(before.statusCode,200,before.body);assert.deepEqual(before.json(),{recovery:{state:'none',execution_authorized:false}});
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_handoff_requests').get().n,0);
 assert.equal((await invoke('start',{request_id:'start',max_hops:2})).statusCode,200);
 const lead=await invoke('recover_return');assert.equal(lead.statusCode,200,lead.body);assert.deepEqual(lead.json(),{recovery:{state:'none',execution_authorized:false}});
 assert.equal(f.host.get().revision,1);assert.equal(f.host.get().controller,f.a.agent_id);
 const current=await invoke('get');assert.equal(current.statusCode,200,current.body);assert.equal(current.json().state.revision,1,'existing get semantics remain unchanged');
});
test('return recovery treats every stopped handoff as blocked, never as a fresh lead state',async t=>{
 const f=await setup(t);
 const started=await handoffRequest(f,'start',{request_id:'stopped-start',max_hops:2});assert.equal(started.statusCode,200,started.body);
 const stopped=await handoffRequest(f,'stop',{request_id:'stopped-stop',expected_revision:1});assert.equal(stopped.statusCode,200,stopped.body);
 const state=f.db.prepare('SELECT state_json FROM wb_task_handoff_control WHERE owner_id=? AND root_run_id=?').get('alice',f.runId).state_json;
 const count=f.db.prepare('SELECT count(*) n FROM wb_task_handoff_requests WHERE owner_id=? AND root_run_id=?').get('alice',f.runId).n;
 const response=await handoffRequest(f,'recover_return');assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json(),{recovery:{state:'blocked',execution_authorized:false,reason:'handoff_stopped'}});
 assert.equal(f.db.prepare('SELECT state_json FROM wb_task_handoff_control WHERE owner_id=? AND root_run_id=?').get('alice',f.runId).state_json,state);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_handoff_requests WHERE owner_id=? AND root_run_id=?').get('alice',f.runId).n,count);
});
test('return recovery blocks an unclosed bound child and never substitutes another run of the same role',async t=>{
 const f=await setup(t),bound=prepareNativeChild(f,'bound-child','bound-spawn'),decoy=prepareNativeChild(f,'decoy-child','decoy-spawn');
 const transferred=await transferToChild(f,bound);assert.equal(transferred.statusCode,200,transferred.body);
 const closed=await closeNativeChild(f,decoy);assert.equal(closed.statusCode,200,closed.body);
 const before=f.db.prepare('SELECT state_json FROM wb_task_handoff_control').get().state_json,requestCount=f.db.prepare('SELECT count(*) n FROM wb_task_handoff_requests').get().n;
 const response=await handoffRequest(f,'recover_return');assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json(),{recovery:{state:'blocked',execution_authorized:false,reason:'child_closure_unavailable'}});
 assert.equal(f.db.prepare('SELECT state_json FROM wb_task_handoff_control').get().state_json,before);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_handoff_requests').get().n,requestCount);
});
test('return recovery reports pending only for the exact bound latest child and verified immutable proof',async t=>{
 const f=await setup(t),child=prepareNativeChild(f,'pending-child','pending-spawn');
 const transferred=await transferToChild(f,child);assert.equal(transferred.statusCode,200,transferred.body);
 const closed=await closeNativeChild(f,child);assert.equal(closed.statusCode,200,closed.body);
 const requestCount=f.db.prepare('SELECT count(*) n FROM wb_task_handoff_requests').get().n;
 const response=await handoffRequest(f,'recover_return');assert.equal(response.statusCode,200,response.body);
 const requestId='handoff-return-'+createHash('sha256').update(JSON.stringify([f.runId,'session-fixture',child.run_id,child.session_ref])).digest('hex');
 assert.deepEqual(response.json(),{recovery:{state:'pending',execution_authorized:false,revision:2,lead_role_ref:f.a.agent_id,role_ref:f.member.agent_id,child_run_id:child.run_id,child_session_ref:child.session_ref,proof:closureProof(child.session_ref),request_id:requestId}});
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_handoff_requests').get().n,requestCount);
 assert.equal(f.db.prepare('SELECT revision,run_id,session_ref FROM wb_task_handoff_executions WHERE owner_id=? AND root_run_id=? AND revision=2').get('alice',f.runId).run_id,child.run_id);
});
test('return recovery refuses a native closure whose persisted digest does not verify',async t=>{
 const f=await setup(t),child=prepareNativeChild(f,'tampered-proof-child','tampered-proof-spawn');
 const transferred=await transferToChild(f,child);assert.equal(transferred.statusCode,200,transferred.body);
 const closed=await closeNativeChild(f,child);assert.equal(closed.statusCode,200,closed.body);
 f.db.exec('DROP TRIGGER wb_native_child_closure_no_update');f.db.prepare('UPDATE wb_native_child_closures SET receipt_sha256=? WHERE run_id=?').run('f'.repeat(64),child.run_id);
 const response=await handoffRequest(f,'recover_return');assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json(),{recovery:{state:'blocked',execution_authorized:false,reason:'native_child_proof_unverified'}});
});
test('return recovery reconstructs a committed lost return from durable receipt after reopening the database',async t=>{
 const f=await setup(t),child=prepareNativeChild(f,'returned-child','returned-spawn');
 const transferred=await transferToChild(f,child);assert.equal(transferred.statusCode,200,transferred.body);
 const closed=await closeNativeChild(f,child);assert.equal(closed.statusCode,200,closed.body);
 const expectedRequestId='handoff-return-'+createHash('sha256').update(JSON.stringify([f.runId,'session-fixture',child.run_id,child.session_ref])).digest('hex');
 const returned=await handoffRequest(f,'transfer',{request_id:expectedRequestId,expected_revision:2,from:f.member.agent_id,to:f.a.agent_id,execution_run_id:f.runId,execution_session_ref:'session-fixture'});
 assert.equal(returned.statusCode,200,returned.body);assert.equal(returned.json().state.phase,'returned');
 const storedReceipt=f.host.readReceipt('transfer',{request_id:expectedRequestId,expected_revision:2,from:f.member.agent_id,to:f.a.agent_id});assert.equal(storedReceipt.found,true);assert.equal(storedReceipt.digest_matches,true,JSON.stringify(storedReceipt));assert.deepEqual(storedReceipt.response,returned.json().state);
 const reopened=await buildServer(f.fixtureConfig);let response;
 try{response=await reopened.app.inject({method:'POST',url:'/internal/v1/workbench/handoff',headers:{authorization:'Bearer '+f.fixtureConfig.internalChannelToken},payload:{...identityFor(f),action:'recover_return',request:{},expected_policy_version:1,route:{provider:'fixture',model:'bounded'}}});}finally{await reopened.app.close();reopened.db.close();}
 assert.equal(response.statusCode,200,response.body);
 const requestId='handoff-return-'+createHash('sha256').update(JSON.stringify([f.runId,'session-fixture',child.run_id,child.session_ref])).digest('hex');
 assert.deepEqual(response.json(),{recovery:{state:'returned',execution_authorized:false,revision:3,lead_role_ref:f.a.agent_id,role_ref:f.member.agent_id,child_run_id:child.run_id,child_session_ref:child.session_ref,proof:closureProof(child.session_ref),request_id:requestId,receipt:{state:returned.json().state}}});
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_handoff_requests').get().n,3);
});
test('return recovery rejects an immutable return receipt with a mismatched request digest',async t=>{
 const f=await setup(t),child=prepareNativeChild(f,'tampered-return-child','tampered-return-spawn');
 const transferred=await transferToChild(f,child);assert.equal(transferred.statusCode,200,transferred.body);
 const closed=await closeNativeChild(f,child);assert.equal(closed.statusCode,200,closed.body);
 const requestId='handoff-return-'+createHash('sha256').update(JSON.stringify([f.runId,'session-fixture',child.run_id,child.session_ref])).digest('hex');
 const returned=await handoffRequest(f,'transfer',{request_id:requestId,expected_revision:2,from:f.member.agent_id,to:f.a.agent_id,execution_run_id:f.runId,execution_session_ref:'session-fixture'});assert.equal(returned.statusCode,200,returned.body);
 const receipt=f.db.prepare('SELECT digest,response_json FROM wb_task_handoff_requests WHERE owner_id=? AND root_run_id=? AND request_id=?').get('alice',f.runId,requestId);
 f.db.exec('DROP TRIGGER wb_task_handoff_request_no_update');f.db.prepare('UPDATE wb_task_handoff_requests SET digest=? WHERE owner_id=? AND root_run_id=? AND request_id=?').run('0'.repeat(64),'alice',f.runId,requestId);
 const badDigest=await handoffRequest(f,'recover_return');assert.equal(badDigest.statusCode,200,badDigest.body);assert.deepEqual(badDigest.json(),{recovery:{state:'blocked',execution_authorized:false,reason:'handoff_return_receipt_unverified'}});
 f.db.exec('DROP TRIGGER wb_task_handoff_request_no_update');
 f.db.prepare('UPDATE wb_task_handoff_requests SET digest=?,response_json=? WHERE owner_id=? AND root_run_id=? AND request_id=?').run(receipt.digest,JSON.stringify({...returned.json().state,revision:99}),'alice',f.runId,requestId);
 const badResponse=await handoffRequest(f,'recover_return');assert.equal(badResponse.statusCode,200,badResponse.body);assert.deepEqual(badResponse.json(),{recovery:{state:'blocked',execution_authorized:false,reason:'handoff_return_receipt_unverified'}});
});
test('return recovery preserves existing authorization rejection for stale lease, revoked policy, and task cancellation',async t=>{
 const f=await setup(t);
 assert.notEqual((await handoffRequest(f,'recover_return',{}, {session_ref:'foreign-session'})).statusCode,200);
 assert.notEqual((await handoffRequest(f,'recover_return',{}, {execution_lease:{owner:'handoff-worker',generation:2}})).statusCode,200);
 f.collaboration.save('alice',f.task.task_id,{expected_version:1,enabled:false});
 const revoked=await handoffRequest(f,'recover_return');assert.notEqual(revoked.statusCode,200);assert.notEqual(revoked.json().recovery?.state,'blocked');
});
test('return recovery rejects cancelled task instead of disguising cancellation as blocked',async t=>{
 const f=await setup(t),run=f.runs.get(f.runId,'alice');
 f.persistentTasks.cancelOccurrence('alice',f.task.task_id,f.occurrence.occurrence_id,run.version,'cancel-recovery');
 const response=await handoffRequest(f,'recover_return');assert.notEqual(response.statusCode,200);assert.notEqual(response.json().recovery?.state,'blocked');
});
test('changed policy rejects old request replay and status access',async t=>{const f=await setup(t);f.host.start({request_id:'start',max_hops:2});f.collaboration.save('alice',f.task.task_id,{expected_version:1,enabled:false});assert.throws(()=>f.host.start({request_id:'start',max_hops:2}),/task_collaboration_revoked/);assert.throws(()=>f.host.get(),/task_collaboration_revoked/);});
test('unsettled model usage blocks transfer while stop remains possible',async t=>{const f=await setup(t);f.host.start({request_id:'start',max_hops:2});f.modelBudgets.reserve('alice',f.runId,{attempt_id:'pending',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',f.runId,'pending');assert.throws(()=>f.host.transfer({request_id:'transfer',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id}),/handoff_usage_unresolved/);assert.equal(f.host.get().revision,1);assert.equal(f.host.stop({request_id:'stop',expected_revision:1}).phase,'stopped');assert.equal(f.db.prepare("SELECT state FROM wb_model_budget_attempts WHERE attempt_id='pending'").get().state,'in_flight');});
test('worker replacement revokes host control',async t=>{const f=await setup(t);f.host.start({request_id:'start',max_hops:2});f.db.prepare('UPDATE ga_worker_leases SET generation=generation+1 WHERE resource_id=?').run(f.runId);assert.throws(()=>f.host.get(),/workbench_execution_lease_revoked/);});
test('owner occurrence cancellation blocks transfer and leaves the controller unchanged',async t=>{const f=await setup(t);f.host.start({request_id:'start',max_hops:2});const run=f.runs.get(f.runId,'alice');f.persistentTasks.cancelOccurrence('alice',f.task.task_id,f.occurrence.occurrence_id,run.version,'cancel');assert.throws(()=>f.host.transfer({request_id:'transfer',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id}));const stored=JSON.parse(f.db.prepare('SELECT state_json FROM wb_task_handoff_control').get().state_json);assert.equal(stored.revision,1);assert.equal(stored.controller,f.a.agent_id);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_handoff_requests').get().n,1);});
test('exact root execution binding rejects another Session and stale controller revision',async t=>{const f=await setup(t);f.host.start({request_id:'start',max_hops:2});const input={expected_revision:1,run_id:f.runId,session_ref:'session-fixture'};const bound=f.host.bindExecution(input);assert.deepEqual(f.host.bindExecution(input),bound);assert.equal(f.host.assertExecution(input).run_id,f.runId);assert.throws(()=>f.host.bindExecution({...input,session_ref:'different-session'}),/handoff_execution_forbidden/);f.host.transfer({request_id:'next',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id});assert.throws(()=>f.host.assertExecution(input),/handoff_revision_conflict/);});
test('a second native execution of the same role cannot inherit the first binding',async t=>{const f=await setup(t);const reservations=new NativeChildReservations(f.db,f.collaboration);const first=reservations.reserve({run_id:f.runId,session_ref:'session-fixture',child_session_ref:'child-one',role_ref:f.member.agent_id,request_id:'spawn-one',expected_policy_version:1,execution_lease:{owner:'handoff-worker',generation:1}});const child=f.workbench.prepareNativeChild('alice',first.reservation_id);const second=reservations.reserve({run_id:f.runId,session_ref:'session-fixture',child_session_ref:'child-two',role_ref:f.member.agent_id,request_id:'spawn-two',expected_policy_version:1,execution_lease:{owner:'handoff-worker',generation:1}});const other=f.workbench.prepareNativeChild('alice',second.reservation_id);f.host.start({request_id:'start',max_hops:2});f.host.transfer({request_id:'transfer',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id});const input={expected_revision:2,run_id:child.run_id,session_ref:'child-one'};assert.equal(f.host.bindExecution(input).run_id,child.run_id);assert.equal(f.host.assertExecution(input).run_id,child.run_id);const writeAs=(run_id,session_ref,call_id,path)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/tool',headers:{authorization:'Bearer '+f.fixtureConfig.internalChannelToken},payload:{run_id,session_ref,call_id,operation:'files.write',arguments:{path,content:'bound instance',expected_version:0}}});assert.equal((await writeAs(child.run_id,'child-one','allowed-write','allowed.txt')).statusCode,200);assert.notEqual((await writeAs(other.run_id,'child-two','denied-write','denied.txt')).statusCode,200);assert.throws(()=>f.workbench.readFile('alice','ws',f.a.project_id,'denied.txt'));assert.throws(()=>f.host.assertExecution({...input,run_id:other.run_id,session_ref:'child-two'}),/handoff_execution_conflict/);assert.throws(()=>f.host.bindExecution({...input,run_id:other.run_id,session_ref:'child-two'}),/handoff_execution_conflict/);assert.throws(()=>f.host.bindExecution({...input,run_id:f.runId,session_ref:'session-fixture'}),/handoff_execution_forbidden/);f.host.stop({request_id:'stop',expected_revision:2});assert.throws(()=>f.host.assertExecution(input),/handoff_revision_conflict/);assert.throws(()=>f.host.assertExecution({...input,expected_revision:3}),/handoff_closed/);});
test('actual tool guard enforces handoff binding while parent planning remains available',async t=>{
 const f=await setup(t),identity={run_id:f.runId,session_ref:'session-fixture'};const internal=(name,payload)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/'+name,headers:{authorization:'Bearer '+f.fixtureConfig.internalChannelToken},payload});
 const guard=()=>internal('guard',{...identity,tool_name:'jot_workspace'});
 assert.equal((await guard()).statusCode,200);f.host.start({request_id:'start',max_hops:2});assert.notEqual((await guard()).statusCode,200);
 f.host.bindExecution({expected_revision:1,...identity});assert.equal((await guard()).statusCode,200);
 f.host.transfer({request_id:'transfer',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id});assert.notEqual((await guard()).statusCode,200);
 assert.equal((await internal('guard',identity)).statusCode,200,'root planning permission remains distinct');
 const write=await internal('tool',{...identity,call_id:'denied-write',operation:'files.write',arguments:{path:'handoff-denied.txt',content:'must not write',expected_version:0}});assert.notEqual(write.statusCode,200);assert.throws(()=>f.workbench.readFile('alice','ws',f.a.project_id,'handoff-denied.txt'));
});
test('a recorded web operation without settled outcome blocks handoff',async t=>{const f=await setup(t);f.host.start({request_id:'start',max_hops:2});f.db.prepare('INSERT INTO ga_web_operation_cursors(run_id,tool_call_id,session_ref,operation_id,last_revision,started_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(f.runId,'web-call','session-fixture','web-'+ 'a'.repeat(32),1,'now','now');assert.throws(()=>f.host.transfer({request_id:'transfer',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id}),/handoff_operation_unresolved/);assert.equal(f.host.get().revision,1);});
test('only a newer validated terminal snapshot with every item settled releases the operation barrier',async t=>{
 const f=await setup(t),lease={...f.lease,owner:'handoff-worker',generation:1};f.coordinator.bindSession(lease,'session-fixture');f.host.start({request_id:'start',max_hops:2});
 const snapshot=(revision,status,itemStatus)=>({operation_id:'web-'+ 'b'.repeat(32),kind:'execute',status,revision,event_cursor:revision,events:[{revision,event_type:'item.updated',payload:{}}],accepted_count:1,counts:{[itemStatus]:1},items:[{item_id:'one',position:0,status:itemStatus,attempt:1,result_ref:null}]});
 const transfer=()=>f.host.transfer({request_id:'transfer',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id});
 f.coordinator.recordWebOperationSnapshot(lease,'session-fixture','web-call',snapshot(1,'running','running'));assert.throws(transfer,/handoff_operation_unresolved/);
 f.coordinator.recordWebOperationSnapshot(lease,'session-fixture','web-call',snapshot(2,'partial','unknown'));assert.throws(transfer,/handoff_operation_unresolved/);
 f.coordinator.recordWebOperationSnapshot(lease,'session-fixture','web-call',snapshot(3,'succeeded','succeeded'));assert.equal(transfer().controller,f.member.agent_id);
});
test('reopening an older cursor schema preserves identity and does not invent completion',async t=>{
 const f=await setup(t);f.host.start({request_id:'start',max_hops:2});f.db.prepare('INSERT INTO ga_web_operation_cursors(run_id,tool_call_id,session_ref,operation_id,last_revision,started_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(f.runId,'old-web','session-fixture','web-'+ 'c'.repeat(32),3,'now','now');f.db.exec('ALTER TABLE ga_web_operation_cursors DROP COLUMN last_status; ALTER TABLE ga_web_operation_cursors DROP COLUMN items_settled;');
 const reopened=openProductDatabase(f.fixtureConfig.databasePath);try{const row=reopened.prepare('SELECT tool_call_id,last_revision,last_status,items_settled FROM ga_web_operation_cursors').get();assert.deepEqual({...row},{tool_call_id:'old-web',last_revision:3,last_status:null,items_settled:0});assert.throws(()=>f.host.transfer({request_id:'transfer',expected_revision:1,from:f.a.agent_id,to:f.member.agent_id}),/handoff_operation_unresolved/);}finally{reopened.close();}
});
