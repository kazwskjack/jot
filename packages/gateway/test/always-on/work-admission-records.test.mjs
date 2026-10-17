import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {workGrantFixture} from './work-grant-fixture.mjs';
import {WorkGrants} from '../../src/always-on/work-grants.ts';
import {RunCommandService} from '../../src/runs/commands.ts';
import {withImmediateTransaction,openProductDatabase} from '../../src/db/database.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
const Records=(await import('../../src/always-on/work-admission-records.ts').catch(()=>({}))).WorkAdmissionRecords;
const observation=()=>({activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:Date.now()});
async function setup(t){const f=await workGrantFixture(t),grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'choose');return {...f,grants,grant,authorize:()=>{grants.guard('owner',f.scope,grant.grant_id);return observation();}};}
test('work enqueue atomically creates one original occurrence and immutable receipt with unchanged cumulative scope',async t=>{
 const f=await setup(t);assert.equal(typeof f.tasks.enqueueDiscoveryWork,'function');const before=f.counts(),rootBefore=f.db.prepare('SELECT * FROM wb_model_budget_scopes WHERE scope_id=?').get(f.grant.task_budget_scope_id),record=f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,f.authorize),records=new Records(f.db);
 assert.equal(record.grant_id,f.grant.grant_id);assert.equal(record.task_id,f.grant.task_id);assert.equal(record.task_budget_scope_id,f.grant.task_budget_scope_id);assert.equal(record.execution_authorized,false);assert.ok(Object.isFrozen(record));assert.ok(Object.isFrozen(record.observation));
 const occurrence=f.db.prepare('SELECT * FROM wb_task_occurrences WHERE occurrence_id=?').get(record.occurrence_id);assert.equal(occurrence.trigger_key,'discovery-work:'+f.grant.grant_id);assert.equal(occurrence.run_id,record.run_id);assert.equal(occurrence.conversation_id,record.conversation_id);assert.notEqual(record.conversation_id,f.occurrence.conversation_id);
 assert.equal(f.counts()[0],before[0]+1);assert.equal(f.counts()[1],before[1]+1);assert.equal(f.db.prepare('SELECT runs_used FROM wb_persistent_tasks WHERE task_id=?').get(record.task_id).runs_used,2);
 assert.deepEqual(records.get('owner',f.scope,f.grant.grant_id),record);assert.deepEqual(records.byRun('owner',record.run_id),record);assert.deepEqual(records.guard('owner',record.run_id),record);
 const allocation=JSON.parse(f.db.prepare('SELECT allocation_json FROM wb_budget_allocations WHERE run_id=?').get(record.run_id).allocation_json);assert.deepEqual(allocation.scopes.filter(s=>s.key.startsWith('task-total:')).map(s=>s.scope_id),[record.task_budget_scope_id]);
 const rootAfter=f.db.prepare('SELECT * FROM wb_model_budget_scopes WHERE scope_id=?').get(record.task_budget_scope_id);for(const key of ['scope_id','scope_key','limits_json','used_tokens','used_nano_usd','used_model_calls','created_at'])assert.equal(rootAfter[key],rootBefore[key]);assert.equal(BigInt(rootAfter.held_model_calls),BigInt(rootBefore.held_model_calls)+1n);
 for(const trigger of ['manual:generic','discovery:unreserved','discovery-work:'+f.grant.grant_id])assert.throws(()=>f.db.prepare('INSERT INTO wb_task_occurrences SELECT ?,task_id,?,scheduled_for,generation,conversation_id,run_id,status,business_state,evidence_json,created_at,updated_at FROM wb_task_occurrences WHERE occurrence_id=?').run('unreserved-occurrence',trigger,record.occurrence_id),/task_discovery_admission_required/);
 f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause');assert.deepEqual(f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,()=>{throw Error('historical replay must not reauthorize');}),record);assert.throws(()=>records.guard('owner',record.run_id),/revoked|work_cycle/);
 for(const sql of ['UPDATE wb_discovery_work_admissions SET created_at=created_at','DELETE FROM wb_discovery_work_admissions','INSERT OR REPLACE INTO wb_discovery_work_admissions SELECT * FROM wb_discovery_work_admissions'])assert.throws(()=>f.db.exec(sql),/work_admission_immutable/);
});
test('work admission rejects malformed callback, rollback, foreign owner and scope without consuming occurrence counts',async t=>{
 const f=await setup(t),before=f.counts();
 for(const proof of [true,undefined,Promise.resolve(observation()),{...observation(),extra:true},{...observation(),native_sha256:'bad'}])assert.throws(()=>f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,()=>proof),/work_admission_invalid/);
 assert.throws(()=>f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,()=>{throw Error('revoked');}),/revoked/);assert.throws(()=>f.tasks.enqueueDiscoveryWork('foreign',f.grant.grant_id,f.authorize),/not_found/);assert.deepEqual(f.counts(),before);
 const record=f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,f.authorize),records=new Records(f.db);assert.throws(()=>records.get('owner',{...f.scope,project_id:'foreign'},f.grant.grant_id),/not_found/);assert.equal(records.byRun('foreign',record.run_id),null);
});
test('new connection recovers historical receipt and own in-flight budget call does not revoke work guard',async t=>{
 const f=await setup(t),record=f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,f.authorize),records=new Records(f.db),lease=f.coordinator.claimNext('work-worker',30000);assert.equal(lease.run_id,record.run_id);f.coordinator.start(lease);f.budget.ledger.reserve('owner',record.run_id,{attempt_id:'own-call',provider:'fixture',model:'bounded'});f.budget.ledger.dispatch('owner',record.run_id,'own-call');assert.throws(()=>f.grants.guard('owner',f.scope,f.grant.grant_id),/budget_unconfirmed/);assert.deepEqual(records.guard('owner',record.run_id),record);
 const db=new DatabaseSync(join(f.root,'db.sqlite'));try{assert.deepEqual(new Records(db).byRun('owner',record.run_id),record);}finally{db.close();}
 f.db.prepare('UPDATE wb_task_occurrences SET generation=-1 WHERE occurrence_id=?').run(record.occurrence_id);assert.throws(()=>records.guard('owner',record.run_id),/revoked/);assert.deepEqual(records.get('owner',f.scope,f.grant.grant_id),record);
});
test('new work operations stay closed and original active guard revokes the work occurrence',async t=>{
 const f=await setup(t),record=f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,f.authorize);assert.doesNotThrow(()=>f.tasks.assertRunActive(record.run_id));
 for(const operation of ['files.read','files.write','memory.list','memory.save','messages.send','tasks.delegate'])assert.throws(()=>f.tasks.assertDiscoveryOperation(record.run_id,operation),/work_admission_execution_unavailable/);
 f.cycles.close('owner',f.scope,f.cycle.cycle_id,{expected_version:1},'close');assert.throws(()=>f.tasks.assertRunActive(record.run_id),/work_cycle_closed/);
});
test('failure after original bind and callback revocation roll back all work admission facts',async t=>{
 const f=await setup(t),before=f.counts(),conversations=f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n;
 f.db.exec("CREATE TRIGGER synthetic_work_failure BEFORE UPDATE OF runs_used ON wb_persistent_tasks WHEN NEW.runs_used>1 BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
 assert.throws(()=>f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,f.authorize),/synthetic_failure/);assert.deepEqual(f.counts(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n,conversations);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_admissions').get().n,0);f.db.exec('DROP TRIGGER synthetic_work_failure');
 assert.throws(()=>f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,()=>{const proof=f.authorize();f.db.prepare('UPDATE wb_task_occurrences SET generation=-1 WHERE occurrence_id=?').run(f.occurrence.occurrence_id);return proof;}),/revoked/);assert.deepEqual(f.counts(),before);assert.equal(f.db.prepare('SELECT generation FROM wb_task_occurrences WHERE occurrence_id=?').get(f.occurrence.occurrence_id).generation,f.occurrence.generation);
 assert.ok(f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,f.authorize).run_id);
});
test('independent processes recover exactly one immutable work receipt',{timeout:40000},async t=>{
 const f=await setup(t),children=[];
 async function start(){const child=spawn(process.execPath,[fileURLToPath(new URL('./work-admission-worker.mjs',import.meta.url)),join(f.root,'db.sqlite'),f.root,JSON.stringify(f.scope),f.grant.grant_id],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.push(child);const messages=[],done=new Promise(resolve=>child.once('exit',resolve));let errors='';child.stderr.on('data',data=>errors+=data);child.on('message',message=>messages.push(message));const deadline=Date.now()+15000;while(!messages.some(message=>message.ready)&&child.exitCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(messages.some(message=>message.ready),errors);return{child,messages,done};}
 try{const a=await start(),b=await start();a.child.send({go:true});b.child.send({go:true});assert.deepEqual(await Promise.all([a.done,b.done]),[0,0]);const results=[...a.messages,...b.messages].filter(message=>message.record);assert.equal(results.length,2);assert.deepEqual(results[0].record,results[1].record);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_admissions').get().n,1);assert.equal(f.db.prepare('SELECT runs_used FROM wb_persistent_tasks WHERE task_id=?').get(f.grant.task_id).runs_used,2);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);}finally{for(const child of children)if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}}
});
test('SQL occurrence gate refuses a planning revocation after reservation insertion',async t=>{
 const f=await setup(t),before=f.counts();
 f.db.exec(`CREATE TRIGGER synthetic_revoke_planning AFTER INSERT ON wb_discovery_work_admissions BEGIN UPDATE wb_task_occurrences SET generation=-1 WHERE occurrence_id='${f.occurrence.occurrence_id}'; END`);
 assert.throws(()=>f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,f.authorize),/task_discovery_admission_required/);assert.deepEqual(f.counts(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_admissions').get().n,0);
});
test('post-bind live authority is checked before returning a new receipt',async t=>{
 const f=await setup(t),before=f.counts(),bind=f.workbench.bindRun.bind(f.workbench);f.workbench.bindRun=(...args)=>{bind(...args);f.cycles.close('owner',f.scope,f.cycle.cycle_id,{expected_version:1},'close-during-bind');};
 assert.throws(()=>f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,f.authorize),/work_cycle_closed/);assert.deepEqual(f.counts(),before);assert.equal(f.cycles.get('owner',f.scope,f.cycle.cycle_id).state,'open');
});
test('unrelated run cannot acquire work lineage through a mismatched continuation row',async t=>{
 const f=await setup(t),record=f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,f.authorize),other=f.runs.enqueue(f.agent.conversation_id,'owner',{client_message_id:'unrelated-work-run',content:[{type:'text',text:'unrelated'}]});
 f.db.prepare('INSERT INTO wb_task_continuations VALUES(?,?,?,?)').run(other.run_id,record.occurrence_id,record.run_id,new Date().toISOString());
 assert.throws(()=>new Records(f.db).byRun('owner',other.run_id),/work_admission_lineage_invalid/);
});
test('actual role revocation after reservation or during binding rolls back work admission',async t=>{
 for(const phase of ['after_reservation','during_bind']){
  const f=await setup(t),before=f.counts(),epoch=f.db.prepare('SELECT capability_epoch FROM wb_agents WHERE agent_id=?').get(f.scope.agent_id).capability_epoch;
  if(phase==='after_reservation')f.db.exec(`CREATE TRIGGER synthetic_revoke_role AFTER INSERT ON wb_discovery_work_admissions BEGIN UPDATE wb_agents SET capability_epoch=capability_epoch+1 WHERE agent_id='${f.scope.agent_id}'; END`);
  else{const bind=f.workbench.bindRun.bind(f.workbench);f.workbench.bindRun=(...args)=>{bind(...args);f.db.prepare('UPDATE wb_agents SET capability_epoch=capability_epoch+1 WHERE agent_id=?').run(f.scope.agent_id);};}
  assert.throws(()=>f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,f.authorize),/work_cycle_authority_revoked/);assert.deepEqual(f.counts(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_admissions').get().n,0);assert.equal(f.db.prepare('SELECT capability_epoch FROM wb_agents WHERE agent_id=?').get(f.scope.agent_id).capability_epoch,epoch);
 }
});
test('real original checkpoint continuation guards the same admitted work occurrence and cumulative scope',async t=>{
 const f=await setup(t),record=f.tasks.enqueueDiscoveryWork('owner',f.grant.grant_id,f.authorize),records=new Records(f.db),lease=f.coordinator.claimNext('work-checkpoint-worker',30000);assert.equal(lease.run_id,record.run_id);f.coordinator.start(lease);const now=new Date().toISOString();
 // Synthetic native Goal receipt exercises original saver/resume/lineage APIs;
 // it is not an SDK/native execution acceptance claim.
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(record.conversation_id,'owner','work-checkpoint-session',now,now);
 f.db.prepare('INSERT INTO wb_native_goal_bindings VALUES(?,?,?,?,?,?)').run(record.run_id,record.occurrence_id,'work-synthetic-goal',3,now,now);
 const checkpoint=f.coordinator.recordCheckpoint(lease,'work-checkpoint-session',{session_ref:'work-checkpoint-session',seq_exclusive:5,turn_end_seq:4,goal_id:'work-synthetic-goal',goal_revision:3,log_sha256:'a'.repeat(64)});f.coordinator.interruptWithoutRuntime(lease,'SESSION_TURN_INTERRUPTED');
 const counts=f.counts(),beforeUsed=f.tasks.get('owner',record.task_id).runs_used,commands=new RunCommandService(f.db,f.events),next=withImmediateTransaction(f.db,()=>{const resumed=commands.resume(record.run_id,'owner',{expected_run_version:f.runs.get(record.run_id,'owner').version,checkpoint_id:checkpoint},'work-resume');f.workbench.inheritCheckpointRun('owner',record.run_id,resumed.run_id);return resumed.run_id;});
 assert.deepEqual(records.guard('owner',next),record);assert.throws(()=>records.guard('owner',record.run_id),/work_admission_authority_revoked/);assert.deepEqual(records.byRun('owner',next),record);assert.equal(f.tasks.get('owner',record.task_id).runs_used,beforeUsed);assert.equal(f.counts()[1],counts[1]);assert.equal(f.tasks.occurrences('owner',record.task_id).items.find(item=>item.occurrence_id===record.occurrence_id).run_id,next);
 const scope=JSON.parse(f.db.prepare('SELECT allocation_json FROM wb_budget_allocations WHERE run_id=?').get(next).allocation_json).scopes.filter(scope=>scope.key.startsWith('task-total:'));assert.deepEqual(scope.map(scope=>scope.scope_id),[record.task_budget_scope_id]);
 for(const operation of ['files.read','files.write','memory.save','tasks.delegate'])assert.throws(()=>f.tasks.assertDiscoveryOperation(next,operation),/work_admission_execution_unavailable/);
});
test('narrow task schema stays closed and later real Workbench installation replaces its work guard',async t=>{
 const f=await setup(t),db=openProductDatabase(':memory:');try{
  const unavailable={getAgent(){throw Error('agent_unavailable');},bindRun(){throw Error('agent_unavailable');}};new PersistentTaskService(db,unavailable);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='wb_work_admission_valid'").get().sql,/AND \(1\)/);
  const workbench=new WorkbenchService(db,{workspaceIds:['ws'],root:join(f.root,'schema-upgrade-workbench')});new PersistentTaskService(db,workbench);
  const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='wb_work_admission_valid'").get().sql;assert.match(sql,/JOIN wb_agents/);assert.doesNotMatch(sql,/AND \(1\)/);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});
