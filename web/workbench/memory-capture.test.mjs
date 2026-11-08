import test from 'node:test';
import assert from 'node:assert/strict';
import {captureMatches,captureSourceView,captureAction,capturePolicyInput,captureReconcileInput} from './memory-capture.mjs';
test('capture review remains bound to the current role and project',()=>{
 assert.equal(captureMatches({agent_id:'a',project_id:'p'},{agent_id:'a',project_id:'p'}),true);assert.equal(captureMatches({agent_id:'b',project_id:'p'},{agent_id:'a',project_id:'p'}),false);
});
test('unavailable sources suppress cached text and invalid batches cannot be approved',()=>{
 assert.equal(captureSourceView({available:false,text:'old secret'}).text,'');
 const value={capture_id:'capture-a',status:'proposed',version:3,policy_current:true,sources:[{available:true}]};assert.deepEqual(captureAction(value,'apply'),{expected_version:3});
 for(const changed of [{policy_current:false},{status:'ready'},{sources:[{available:false}]}])assert.throws(()=>captureAction({...value,...changed},'apply'),/capture_unavailable/);
 assert.deepEqual(captureAction({...value,policy_current:false},'reject'),{expected_version:3});
});
test('policy commands use the current version and contain no identity fields',()=>{
 const input=capturePolicyInput({version:0},true,false,true);assert.deepEqual(input,{expected_version:0,mode:'suggest',include_assistant:false,include_automation:true});
 assert.equal(capturePolicyInput({version:2},false,true,false).mode,'off');
});
test('reconciliation binds a proposed capture to the original interrupted unknown-use receipt',()=>{
 const capture={capture_id:'capture-a',status:'proposed',version:4,policy_version:2};
 const evidence={attempt_id:'unknown-call',evidence_ref:'musage-0123456789abcdef'};
 const recovery={capture_status:'proposed',processor_run_status:'interrupted',proposal_available:false,usage_state:'held_unknown',recovery_state:'unresolved_usage_held',reconciliation_evidence:[evidence]};
 assert.deepEqual(captureReconcileInput(capture,recovery,7,evidence),{expected_capture_version:4,expected_policy_version:2,expected_epoch:7,attempt_id:evidence.attempt_id,evidence_ref:evidence.evidence_ref});
 for(const changed of [
  {capture:{...capture,status:'ready'},recovery:{...recovery,capture_status:'ready'}},
  {recovery:{...recovery,capture_status:'ready'}},
  {recovery:{...recovery,processor_run_status:'running'}},
  {recovery:{...recovery,proposal_available:true}},
  {recovery:{...recovery,recovery_state:'source_or_policy_stale'}},
  {recovery:{...recovery,usage_state:'held_in_flight'}},
  {recovery:{...recovery,reconciliation_evidence:[]}},
  {recovery:{...recovery,reconciliation_evidence:[{...evidence,evidence_ref:'memory-usage/other'}]}},
  {capture:{...capture,version:0}},
  {epoch:Number.NaN},
 ])assert.throws(()=>captureReconcileInput(changed.capture??capture,changed.recovery??recovery,changed.epoch??7,evidence),/capture_unavailable/);
 assert.throws(()=>captureReconcileInput(capture,recovery,undefined,evidence),/capture_unavailable/);
});
