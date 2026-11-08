// Real installed SDK, Gateway, Worker, native Goal and isolated IO; only the
// loopback Messages model endpoint is scripted. Opt in explicitly after wiring.
import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeIsolatedWorkCase} from './native-isolated-work-fixture.mjs';
const enabled=!!process.env.JOT_DSH_RUNTIME_MODULES&&process.env.JOT_NATIVE_ISOLATED_WORK_ACCEPTANCE==='true';
async function coldRecovery(t,round){
 t.diagnostic(JSON.stringify({m08_08_cold_recovery_round:round}));
 const result=await nativeIsolatedWorkCase(t,{discovery:true,noPlan:true,discoveryWait:true,maintenanceDriven:true,gateScenario:'positive'});
 t.diagnostic(JSON.stringify({m08_08_cold_recovery_result:result}));
 assert.equal(result.wait_recovered,true);assert.equal(result.admissions,1);assert.equal(result.occurrences,1);assert.equal(result.runs,2);assert.equal(result.reports,1);assert.equal(result.model_requests,7);
 assert.ok(result.process_count>=2);assert.equal(result.process_exit_count,result.process_count);assert.equal(result.sqlite_busy_count,0);assert.equal(result.sqlite_locked_count,0);
 return result;
}
async function twoProcessAdmissionRace(t,round){
 t.diagnostic(JSON.stringify({m08_08_two_process_round:round}));
 const result=await nativeIsolatedWorkCase(t,{discovery:true,noPlan:true,maintenanceDriven:true,gateScenario:'two-process-admission-race'});
 assert.equal(result.admissions,1);assert.equal(result.occurrences,1);assert.equal(result.runs,1);assert.equal(result.reports,1);assert.equal(result.model_requests,5);
 // Two Workers race at the barrier; a third Worker is restarted after review to finish the run.
 assert.equal(result.process_count,3);assert.equal(result.process_exit_count,3);assert.equal(result.sqlite_busy_count,0);assert.equal(result.sqlite_locked_count,0);assert.equal(result.barrier_arrivals,2);assert.ok(result.lease_generation>0);assert.ok(['m08-08-admission-a','m08-08-admission-b'].includes(result.lease_owner));
 return result;
}
test('official SDK executes selected isolated work through original owner review and immutable output delivery',{skip:!enabled,timeout:150000},t=>nativeIsolatedWorkCase(t,{discovery:true}));
test('official SDK cold work continuation retains Session Goal objective and one isolated write',{skip:!enabled,timeout:180000},t=>nativeIsolatedWorkCase(t,{discovery:true,workWait:true}));
test('M08.08 actual Worker cleanup-only lifecycle diagnostic',{skip:!enabled,timeout:120000},async t=>{
 const result=await nativeIsolatedWorkCase(t,{discovery:true,noPlan:true,maintenanceDriven:true,gateScenario:'worker-cleanup-only',cleanupOnly:true});
 assert.equal(result.model_requests,0);assert.equal(result.admissions,0);assert.equal(result.occurrences,0);assert.equal(result.runs,0);
 assert.equal(result.process_count,3);assert.equal(result.process_exit_count,3);assert.equal(result.sqlite_busy_count,0);assert.equal(result.sqlite_locked_count,0);
});
test('M08.08 maintenance-driven discovery cold continuation restarts the original Worker and preserves its DSH Session',{skip:!enabled,timeout:240000},async t=>{
 await coldRecovery(t,'C0 reproduction');
});
test('M08.08 cold recovery repeat 1 of 3',{skip:!enabled,timeout:240000},t=>coldRecovery(t,'C1 1/3'));
test('M08.08 cold recovery repeat 2 of 3',{skip:!enabled,timeout:240000},t=>coldRecovery(t,'C1 2/3'));
test('M08.08 cold recovery repeat 3 of 3',{skip:!enabled,timeout:240000},t=>coldRecovery(t,'C1 3/3'));
test('M08.08 two-process admission race 1 of 3',{skip:!enabled,timeout:240000},t=>twoProcessAdmissionRace(t,'P1 1/3'));
test('M08.08 two-process admission race 2 of 3',{skip:!enabled,timeout:240000},t=>twoProcessAdmissionRace(t,'P1 2/3'));
test('M08.08 two-process admission race 3 of 3',{skip:!enabled,timeout:240000},t=>twoProcessAdmissionRace(t,'P1 3/3'));
test('M08.08 pause remains in force across cold Worker restart',{skip:!enabled,timeout:150000},async t=>{
 const result=await nativeIsolatedWorkCase(t,{discovery:true,maintenanceDriven:true,gateScenario:'pause-cold-restart'});
 assert.equal(result.admissions,0);assert.equal(result.occurrences,0);assert.equal(result.runs,0);assert.equal(result.model_requests,0);assert.equal(result.process_count,2);assert.equal(result.process_exit_count,2);assert.equal(result.sqlite_busy_count,0);assert.equal(result.sqlite_locked_count,0);
});
test('M08.08 stop remains in force across cold Worker restart',{skip:!enabled,timeout:150000},async t=>{
 const result=await nativeIsolatedWorkCase(t,{discovery:true,maintenanceDriven:true,gateScenario:'stop-cold-restart'});
 assert.equal(result.admissions,0);assert.equal(result.occurrences,0);assert.equal(result.runs,0);assert.equal(result.model_requests,0);assert.equal(result.process_count,2);assert.equal(result.process_exit_count,2);assert.equal(result.sqlite_busy_count,0);assert.equal(result.sqlite_locked_count,0);
});
test('M08.08 unknown model outcome is not replayed after cold Worker restart',{skip:!enabled,timeout:150000},async t=>{
 const result=await nativeIsolatedWorkCase(t,{discovery:true,maintenanceDriven:true,gateScenario:'unknown-no-replay-cold-restart'});
 assert.equal(result.admissions,1);assert.equal(result.occurrences,1);assert.equal(result.runs,1);assert.equal(result.model_requests,1);assert.equal(result.process_count,2);assert.equal(result.process_exit_count,2);assert.equal(result.sqlite_busy_count,0);assert.equal(result.sqlite_locked_count,0);
});

test('official SDK admits maintained discovery through original Worker, deduplicates its source revision, and settles budget',{skip:!enabled,timeout:180000},t=>nativeIsolatedWorkCase(t,{discovery:true,noPlan:true,maintenanceDriven:true,gateScenario:'positive'}));
test('maintained discovery waits for the official DSH role Session to become idle',{skip:!enabled,timeout:90000},t=>nativeIsolatedWorkCase(t,{discovery:true,maintenanceDriven:true,gateScenario:'busy-native'}));
test('maintained discovery respects recent foreground owner input',{skip:!enabled,timeout:90000},t=>nativeIsolatedWorkCase(t,{discovery:true,maintenanceDriven:true,gateScenario:'recent-foreground-input'}));
test('maintained discovery refuses a new source revision during cooldown',{skip:!enabled,timeout:180000},t=>nativeIsolatedWorkCase(t,{discovery:true,noPlan:true,maintenanceDriven:true,gateScenario:'cooldown'}));
test('maintained discovery rechecks policy pause after native observation',{skip:!enabled,timeout:90000},t=>nativeIsolatedWorkCase(t,{discovery:true,maintenanceDriven:true,gateScenario:'pause-during-observation'}));
test('maintained discovery rechecks policy stop after native observation',{skip:!enabled,timeout:90000},t=>nativeIsolatedWorkCase(t,{discovery:true,maintenanceDriven:true,gateScenario:'stop-during-observation'}));
test('maintained discovery fences a late official Session result after Worker lease invalidation',{skip:!enabled,timeout:90000},t=>nativeIsolatedWorkCase(t,{discovery:true,maintenanceDriven:true,gateScenario:'lease-invalidated'}));
test('maintained discovery leaves an ambiguous official Session outcome unknown and never replays it',{skip:!enabled,timeout:90000},t=>nativeIsolatedWorkCase(t,{discovery:true,maintenanceDriven:true,gateScenario:'unknown-no-replay'}));

test('M08.08 in-flight leased Worker exit preserves original occurrence and never replays an unknown model call',{skip:!enabled,timeout:180000},async t=>{
 const result=await nativeIsolatedWorkCase(t,{discovery:true,maintenanceDriven:true,gateScenario:'inflight-worker-exit'});
 assert.equal(result.model_requests,1);assert.equal(result.occurrences,1);assert.equal(result.runs,1);assert.equal(result.process_count,2);assert.equal(result.run_status,'interrupted');
});
test('M09.05 actual persistent-task pause is consumed once by the DSH command dispatcher during an in-flight run',{skip:!enabled,timeout:120000},async t=>{
 const result=await nativeIsolatedWorkCase(t,{persistent:true,gateScenario:'task-pause-inflight'});
 assert.equal(result.task_status,'paused');assert.equal(result.control_action,'pause');assert.equal(result.run_status,'cancelled');assert.equal(result.cancel_commands,1);assert.equal(result.cancel_status,'applied');assert.equal(result.sdk_cancel_requests,1);assert.equal(result.model_requests,1);assert.equal(result.occurrences,1);assert.equal(result.process_count,2);
});
test('M09.05 actual persistent-task stop/archive is consumed once by the DSH command dispatcher during an in-flight run',{skip:!enabled,timeout:120000},async t=>{
 const result=await nativeIsolatedWorkCase(t,{persistent:true,gateScenario:'task-archive-inflight'});
 assert.equal(result.task_status,'archived');assert.equal(result.control_action,'archive');assert.equal(result.run_status,'cancelled');assert.equal(result.cancel_commands,1);assert.equal(result.cancel_status,'applied');assert.equal(result.sdk_cancel_requests,1);assert.equal(result.model_requests,1);assert.equal(result.occurrences,1);assert.equal(result.process_count,2);
});
