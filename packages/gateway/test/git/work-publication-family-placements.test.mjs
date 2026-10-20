import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {rename,mkdir} from 'node:fs/promises';
import {publicationReviewFixture} from '../support/work-publication-fixture.mjs';
import {addHistoricalWork} from '../support/publication-history-fixture.mjs';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {WorkPublicationExecutions,installWorkPublicationExecutions} from '../../src/persistent-tasks/work-publication-executions.ts';
import {upgradeWorkspacePublicationCoordination} from '../../src/workbench/workspace-coordination-upgrade.ts';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
import {TaskCollaborationService} from '../../src/workbench/task-collaboration.ts';
import {TaskDelegationService} from '../../src/workbench/task-delegation.ts';
import {NativeChildReservations} from '../../src/workbench/native-child-reservations.ts';
import {assertNativeReservation} from '../../src/workbench/native-child-identity.ts';
import {createHash} from 'node:crypto';
const module=await import('../../src/persistent-tasks/publication-native-placements.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error});
const read=(...args)=>{assert.equal(typeof module.readReservedPublicationPlacements,'function');return module.readReservedPublicationPlacements(...args)};

async function historyFixture(t,{duringRun}={}){
 const f=await publicationReviewFixture(t),history=await addHistoricalWork(f,{duringRun:bound=>duringRun?.(f,bound)});
 const review=await f.service.prepare('owner',f.scope.project_id,f.input),approved=await f.service.control('owner',f.scope.project_id,review.intent_id,{request_id:'approve-history',action:'approve',expected_version:1,review_sha256:review.review_sha256});
 upgradeWorkspacePublicationCoordination(f.db);installWorkPublicationExecutions(f.db);const executions=new WorkPublicationExecutions(f.db,f.workbench,f.service),accepted=withImmediateTransaction(f.db,()=>executions.admit('owner',f.scope.project_id,review.intent_id,{request_id:'history-original-publication',expected_version:approved.version,review_sha256:approved.review_sha256}));
 executions.reserveWorkspace('owner',f.scope.project_id,accepted.execution_id);
 const source={owner_id:'owner',project_id:f.scope.project_id,operation_kind:'work_publication',operation_id:accepted.execution_id,binding_sha256:f.workbench.executionBinding('owner',f.scope.project_id)};
 return{...f,executions,source,accepted,history};
}

test('the complete original family associates two closed isolated work histories without assigning their chat Session to the work root',async t=>{
 assert.equal(typeof module.readReservedPublicationPlacements,'function');const f=await historyFixture(t),before=f.db.prepare('SELECT total_changes() n').get().n;
 const result=read(f.db,f.source),family=f.executions.workspaceFamily('owner',f.scope.project_id,f.accepted.execution_id);
 assert.deepEqual(result.members.map(m=>m.session_ref),family.members.map(m=>m.session_ref));assert.equal(result.family_sha256,family.family_sha256);assert.equal(result.execution_authorized,false);
 assert.equal(result.members.find(m=>m.session_ref==='work-test-session').placement.isolated_root.path,f.prepared.snapshot.isolated_root);
 assert.equal(result.members.find(m=>m.session_ref===f.history.session).placement.isolated_root.path,f.history.prepared.snapshot.isolated_root);
 assert.equal(result.members.find(m=>m.session_ref===f.history.chat).placement,null);assert.ok(Object.isFrozen(result.members));assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 const db=new DatabaseSync(join(f.root,'db.sqlite'),{readOnly:true});try{assert.deepEqual(read(db,f.source),result)}finally{db.close()}
 assert.throws(()=>read(f.db,{...f.source,owner_id:'foreign'}),/project_not_found|workspace_reservation/);
});

async function delegatedHistory(f,bound){
 const workbench=f.logicalWorkbench,member=workbench.createAgent('owner',{name:'Historical native member',workspace_id:f.scope.workspace_id,project_id:f.scope.project_id});
 const team=workbench.createTeam('owner',{name:'Historical native team',workspace_id:f.scope.workspace_id,project_id:f.scope.project_id,member_ids:[f.scope.agent_id,member.agent_id]});
 const collaboration=new TaskCollaborationService(f.db,workbench,f.tasks,new TaskDelegationService(f.db,workbench,f.tasks));
 const policy=collaboration.save('owner',bound.admission.task_id,{expected_version:0,enabled:true,team_id:team.team_id,member_ids:[member.agent_id],max_delegations:2,max_active:1});
 const reservations=new NativeChildReservations(f.db,collaboration),reservation=reservations.reserve({run_id:bound.admission.run_id,session_ref:bound.session,child_session_ref:'historical-native-child',role_ref:member.agent_id,expected_policy_version:policy.version,request_id:'historical-native-child',execution_lease:{owner:bound.lease.owner,generation:bound.lease.generation}});
 const child=workbench.prepareNativeChild('owner',reservation.reservation_id),proof={protocol:1,session_ref:reservation.child_session_ref,parent_session_ref:bound.session,seq_exclusive:5,turn_end_seq:4,log_sha256:'d'.repeat(64),driver_nonresident:true,inbox_pending:0,remote_operations:[]};
 workbench.closeNativeChild('owner',child.run_id,proof);
 const activation=workbench.prepareNativeActivation('owner',{run_id:bound.admission.run_id,session_ref:bound.session,child_session_ref:reservation.child_session_ref,previous_run_id:child.run_id,previous_log_sha256:proof.log_sha256,previous_seq_exclusive:proof.seq_exclusive,execution_lease:{owner:bound.lease.owner,generation:bound.lease.generation}});
 workbench.closeNativeChild('owner',activation.run_id,{...proof,seq_exclusive:7,turn_end_seq:6,log_sha256:'e'.repeat(64)});
 return{reservation,child,activation};
}

test('closed original native delegation and activation inherit the proved original work snapshot without live parent authority',async t=>{
 const f=await historyFixture(t,{duringRun:delegatedHistory}),{reservation}=f.history.during,inventory=read(f.db,f.source);
 const child=inventory.members.find(member=>member.session_ref===reservation.child_session_ref);assert.equal(child.placement.isolated_root.path,f.history.prepared.snapshot.isolated_root);
 assert.equal(f.executions.workspaceFamily('owner',f.scope.project_id,f.accepted.execution_id).members.find(m=>m.session_ref===reservation.child_session_ref).source_kinds.includes('native_child'),true);
 assert.throws(()=>assertNativeReservation(f.db,'owner',reservation.reservation_id),/native_child_closed/);
 const placement=new FinalizedWorkSources(f.db).nativePlacement('owner',f.admission.run_id,f.input.source_sha256),observations=inventory.members.map(m=>({session_ref:m.session_ref,custody:m.placement?'cold':'absent',cwd:m.placement?.isolated_root.path??null,header_sha256:m.placement?'b'.repeat(64):null}));
 f.workbench.indexEffects('owner',f.scope.project_id).retainPublicationNativeWorkspaceRoots(placement,observations,inventory)();
});

test('a rehashed predecessor closure cannot replace original native activation source history',async t=>{
 const f=await historyFixture(t,{duringRun:delegatedHistory}),before=read(f.db,f.source),{child}=f.history.during;
 f.db.exec('SAVEPOINT synthetic_native_history_fault');try{
  const row=f.db.prepare('SELECT * FROM wb_native_child_closures WHERE run_id=?').get(child.run_id),proof=JSON.parse(row.receipt_json);proof.log_sha256='f'.repeat(64);const json=JSON.stringify(proof);
  f.db.exec('DROP TRIGGER wb_native_child_closure_no_update');f.db.prepare('UPDATE wb_native_child_closures SET receipt_json=?,receipt_sha256=? WHERE run_id=?').run(json,createHash('sha256').update(json).digest('hex'),child.run_id);
  assert.throws(()=>read(f.db,f.source),/work_publication_native_placements_unavailable/);
 }finally{f.db.exec('ROLLBACK TO synthetic_native_history_fault; RELEASE synthetic_native_history_fault')}
 assert.deepEqual(read(f.db,f.source),before);
});

test('a declared original isolated run with missing admission evidence cannot fall back to the configured target',async t=>{
 const f=await historyFixture(t),before=read(f.db,f.source);
 f.db.exec('SAVEPOINT synthetic_missing_admission');try{
  f.db.exec('PRAGMA defer_foreign_keys=ON; DROP TRIGGER wb_work_admission_no_delete');
  f.db.prepare('DELETE FROM wb_discovery_work_admissions WHERE run_id=?').run(f.history.admission.run_id);
  assert.throws(()=>read(f.db,f.source),/work_publication_native_placements_unavailable/);
 }finally{f.db.exec('ROLLBACK TO synthetic_missing_admission; RELEASE synthetic_missing_admission; PRAGMA defer_foreign_keys=OFF')}
 assert.deepEqual(read(f.db,f.source),before);
});

test('original native absence retains the historical association without recreating a missing old snapshot',async t=>{
 const f=await historyFixture(t),inventory=read(f.db,f.source),placement=new FinalizedWorkSources(f.db).nativePlacement('owner',f.admission.run_id,f.input.source_sha256);
 const observations=inventory.members.map(member=>({session_ref:member.session_ref,custody:member.session_ref===placement.session_ref?'resident':'absent',cwd:member.session_ref===placement.session_ref?placement.isolated_root.path:null,header_sha256:member.session_ref===placement.session_ref?'a'.repeat(64):null}));
 const root=f.history.prepared.snapshot.isolated_root;await rename(root,root+'-not-present');
 try{f.workbench.indexEffects('owner',f.scope.project_id).retainPublicationNativeWorkspaceRoots(placement,observations,inventory)();assert.ok(inventory.members.find(m=>m.session_ref===f.history.session).placement)}
 finally{await rename(root+'-not-present',root)}
});

test('configured publication retains every proved historical isolated root and rejects physical replacement of an older failed snapshot',async t=>{
 assert.equal(typeof module.readReservedPublicationPlacements,'function');const f=await historyFixture(t),inventory=read(f.db,f.source),placement=new FinalizedWorkSources(f.db).nativePlacement('owner',f.admission.run_id,f.input.source_sha256);
 const observations=inventory.members.map(member=>({session_ref:member.session_ref,custody:member.placement?'cold':'absent',cwd:member.placement?.isolated_root.path??null,header_sha256:member.placement?'a'.repeat(64):null}));
 const kernel=f.workbench.indexEffects('owner',f.scope.project_id),check=kernel.retainPublicationNativeWorkspaceRoots(placement,observations,inventory);check();
 const root=f.history.prepared.snapshot.isolated_root;await rename(root,root+'-old');await mkdir(root);assert.throws(check,/git_publication_native_workspace_changed/);
});

test('a copied family inventory cannot supply borrowed roots, omit a member or change an original placement',async t=>{
 assert.equal(typeof module.readReservedPublicationPlacements,'function');const f=await historyFixture(t),inventory=read(f.db,f.source),placement=new FinalizedWorkSources(f.db).nativePlacement('owner',f.admission.run_id,f.input.source_sha256);
 const observations=inventory.members.map(member=>({session_ref:member.session_ref,custody:member.placement?'cold':'absent',cwd:member.placement?.isolated_root.path??null,header_sha256:member.placement?'a'.repeat(64):null})),kernel=f.workbench.indexEffects('owner',f.scope.project_id);
 assert.throws(()=>kernel.retainPublicationNativeWorkspaceRoots(placement,observations.slice(1),inventory),/git_publication_native_workspace_association_required/);
 const borrowed=structuredClone(observations);borrowed.find(m=>m.session_ref===f.history.session).cwd=f.rootTarget;
 assert.throws(()=>kernel.retainPublicationNativeWorkspaceRoots(placement,borrowed,inventory),/git_publication_native_workspace_association_required/);
 f.db.exec('SAVEPOINT synthetic_history_drift');try{
  f.db.exec('DROP TRIGGER wb_discovery_workspace_records_no_update');f.db.prepare("UPDATE wb_discovery_workspace_records SET record_sha256=? WHERE cycle_id=?").run('0'.repeat(64),f.history.admission.cycle_id);
  assert.throws(()=>read(f.db,f.source),/work_snapshot_history_unavailable|work_publication_native_placements_unavailable/);
 }finally{f.db.exec('ROLLBACK TO synthetic_history_drift; RELEASE synthetic_history_drift')}
});
