import assert from 'node:assert/strict';
import {WorkCycles} from '../../src/always-on/work-cycles.ts';
import {WorkGrants} from '../../src/always-on/work-grants.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {ensureModeSession} from '../../src/conversations/mode-sessions.ts';

/** Two original admissions in one project, including a separately bound failed
 * historical work Session and a distinct ordinary chat Session. No invented
 * database rows or native history are used to create those original bindings. */
export async function addHistoricalWork(f,{duringRun}={}){
 const cycles=new WorkCycles(f.db);cycles.close('owner',f.scope,f.cycle.cycle_id,{expected_version:1},'close-original-history');
 const cycle=cycles.create('owner',f.scope,{admission_id:f.cycle.admission_id,report_sha256:f.cycle.report_sha256,plan_ids:f.cycle.plans.map(p=>p.plan_id),expected_policy_version:2,expected_role_version:1,expected_role_epoch:1},'another-history-cycle');
 const prepared=await f.manager.prepare('owner',f.scope,cycle.cycle_id,{signal:new AbortController().signal}),grant=new WorkGrants(f.db,f.budget).authorize('owner',f.scope,cycle.cycle_id,{expected_cycle_version:1,expected_policy_version:2,expected_role_version:1,expected_role_epoch:1,snapshot_id:prepared.snapshot.receipt.snapshot_id,source_sha256:prepared.source_sha256},'another-history-grant');
 const admission=f.tasks.enqueueDiscoveryWork('owner',grant.grant_id,()=>({activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:Date.now()}));
 const session=new SessionBindingRepository(f.db,'history').getOrCreate('owner',admission.conversation_id).session_id,chat=ensureModeSession(f.db,'owner',admission.conversation_id,'chat');
 const lease=f.coordinator.claimNext('history-original-worker',120000);assert.equal(lease.run_id,admission.run_id);f.coordinator.start(lease);f.budget.ledger.releaseUndispatched('owner',admission.run_id,'queue-admission');f.coordinator.bindSession(lease,session);
 const during=await duringRun?.({admission,prepared,session,chat,lease});
 f.coordinator.finalizePublication(lease,'failed','SYNTHETIC_HISTORY_FAILURE');cycles.close('owner',f.scope,cycle.cycle_id,{expected_version:1},'close-failed-history');
 return{admission,prepared,session,chat,lease,during};
}
