import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryDreamPump} from '../../src/harness/memory-dream-pump.ts';

const policy={owner_id:'alice',workspace_id:'ws-1',project_id:'project-1',agent_id:'agent-1',scope:'project',enabled:true,policy_version:4,epoch:9,cadence_slot:'2026-10-22T10:00:00.000Z',due_at:'2026-10-22T10:00:00.000Z'};
const source={memory_id:'memory-1',owner_id:'alice',workspace_id:'ws-1',project_id:'project-1',scope:'project',agent_id:null,version:2,source_revision:'rev-2',content:'Synthetic project fact'};
const baseEvidence={run_id:'run-1',owner_id:'alice',workspace_id:'ws-1',project_id:'project-1',agent_id:'agent-1',policy_version:4,epoch:9,cadence_slot:policy.cadence_slot,policy_current:true,source_current:true,consolidation:{consolidation_id:'consolidation-1',run_id:'run-1',owner_id:'alice',workspace_id:'ws-1',project_id:'project-1',scope:'project',agent_id:null,status:'proposed',version:2},budget_attempts:[{state:'settled',bound_exceeded:false}]};

function fixture({enabled=false,candidate={policy,mode:'fresh'},evidence=baseEvidence,claimOverrides={},sessionBehavior,currentError}={}){
 const state={candidate,evidence:structuredClone(evidence),currentError,sessionBehavior};
 const calls={find:0,claim:0,assert:0,session:0,read:0,proposed:0,empty:0,hold:[]};
 const claim={run_id:'run-1',mode:candidate?.mode??'fresh',policy:candidate?.policy??policy,session_id:'session-1',lease:{owner:'idle-1',generation:3},...claimOverrides};
 const ports={
  findCandidate:async(_now,excludeRunIds=[])=>{calls.find++;return state.candidate?.mode==='recovery'&&excludeRunIds.includes(state.candidate.run_id)?null:state.candidate;},
  claim:async()=>{calls.claim++;return claim;},
  assertCurrent:async()=>{calls.assert++;if(state.currentError)throw new Error(state.currentError);},
  memory:{
   list:async()=>[source],
   stage:async(scope,runId)=>({consolidation_id:'consolidation-1',owner_id:scope.owner_id,workspace_id:scope.workspace_id,project_id:scope.project_id,scope:'project',agent_id:null,run_id:runId,status:'draft',version:1}),
   propose:async(scope,runId,id)=>{state.evidence.consolidation={consolidation_id:id,owner_id:scope.owner_id,workspace_id:scope.workspace_id,project_id:scope.project_id,scope:'project',agent_id:null,run_id:runId,status:'proposed',version:2};return state.evidence.consolidation;},
  },
  runSession:async(run,tools,signal)=>{calls.session++;if(state.sessionBehavior)return state.sessionBehavior({run,tools,signal,state});await tools.list();const staged=await tools.stage({memory_ids:['memory-1']});await tools.propose(staged.consolidation_id,{expected_version:1,summary:'Synthetic proposal',changes:[]});},
  readEvidence:async()=>{calls.read++;return state.evidence;},
  finalizeProposed:async()=>{calls.proposed++;state.candidate=null;},
  finalizeNoProposal:async()=>{calls.empty++;state.candidate=null;},
  requireReconciliation:async(_run,reason)=>{calls.hold.push(reason);state.candidate=null;},
 };
 return {state,calls,ports,make:(overrides={})=>new MemoryDreamPump(ports,{enabled,workerId:'idle-1',leaseMs:30000,now:()=>new Date('2026-10-22T10:01:00.000Z'),...overrides})};
}

test('Dream is default-off and does not query policy or claim a run without runtime opt-in',async()=>{
 const f=fixture();
 assert.equal(await f.make().processNext(),null);
 assert.deepEqual(f.calls,{find:0,claim:0,assert:0,session:0,read:0,proposed:0,empty:0,hold:[]});
});

test('an already-aborted worker signal stops before candidate lookup',async()=>{
 const f=fixture({enabled:true}),controller=new AbortController();controller.abort(new Error('worker_shutdown'));
 assert.equal(await f.make().processNext(controller.signal),null);
 assert.equal(f.calls.find,0);
 assert.equal(f.calls.claim,0);
});

test('a worker signal aborted during admission holds the claimed run without starting its session',async()=>{
 const f=fixture({enabled:true}),controller=new AbortController(),claim=f.ports.claim;
 f.ports.claim=async(...args)=>{const value=await claim(...args);controller.abort(new Error('worker_shutdown'));return value;};
 const result=await f.make().processNext(controller.signal);
 assert.equal(result.runtime_status,'memory_dream_reconciliation_required');
 assert.equal(f.calls.session,0);
 assert.deepEqual(f.calls.hold,['interrupted_before_start']);
});

test('Dream only claims enabled, due project policies',async t=>{
 for(const candidate of [
  {policy:{...policy,enabled:false},mode:'fresh'},
  {policy:{...policy,due_at:'2026-10-22T10:02:00.000Z'},mode:'fresh'},
  {policy:{...policy,scope:'private'},mode:'fresh'},
 ]){
  await t.test(candidate.policy.scope==='private'?'private policy':'disabled or not due',async()=>{
   const f=fixture({enabled:true,candidate});
   assert.equal(await f.make().processNext(),null);
   assert.equal(f.calls.claim,0);
   assert.equal(f.calls.session,0);
  });
 }
});

test('a fresh project run exposes only bounded tools and finalizes a settled proposal without applying it',async()=>{
 const f=fixture({enabled:true});
 let memoryRun;
 f.ports.memoryForClaim=claim=>{memoryRun=claim.run_id;return f.ports.memory;};
 const result=await f.make().processNext();
 assert.deepEqual(result,{run_id:'run-1',runtime_status:'memory_dream_proposed'});
 assert.equal(memoryRun,'run-1');
 assert.equal(f.calls.session,1);
 assert.equal(f.calls.proposed,1);
 assert.equal(f.calls.empty,0);
 assert.deepEqual(f.calls.hold,[]);
 assert.equal(f.state.evidence.consolidation.status,'proposed');
});

test('a recovered proposed row finalizes on its original run without starting a second session',async()=>{
 const f=fixture({enabled:true,candidate:{policy,mode:'recovery',run_id:'run-1'}});
 const result=await f.make().processNext();
 assert.deepEqual(result,{run_id:'run-1',runtime_status:'memory_dream_proposed'});
 assert.equal(f.calls.session,0);
 assert.equal(f.calls.proposed,1);
});

test('a lost session response after proposal commit recovers the same run once',async()=>{
 const f=fixture({enabled:true,sessionBehavior:async({tools})=>{await tools.list();const staged=await tools.stage({memory_ids:['memory-1']});await tools.propose(staged.consolidation_id,{expected_version:1,summary:'Synthetic proposal',changes:[]});throw new Error('host_response_lost');}});
 const result=await f.make().processNext();
 assert.deepEqual(result,{run_id:'run-1',runtime_status:'memory_dream_proposed'});
 assert.equal(f.calls.session,1);
 assert.equal(f.calls.proposed,1);
 assert.deepEqual(f.calls.hold,[]);
});

test('unknown budget usage holds reconciliation and a later recovery never replays the session',async()=>{
 const f=fixture({enabled:true,sessionBehavior:async({state})=>{state.evidence.budget_attempts=[{state:'unknown',bound_exceeded:false}];throw new Error('host_response_lost');}});
 const result=await f.make().processNext();
 assert.equal(result.runtime_status,'memory_dream_reconciliation_required');
 assert.equal(f.calls.session,1);
 assert.equal(f.calls.proposed,0);
 assert.deepEqual(f.calls.hold,['usage_unsettled']);
 const recovery=fixture({enabled:true,candidate:{policy,mode:'recovery',run_id:'run-1'},evidence:{...baseEvidence,budget_attempts:[{state:'unknown',bound_exceeded:false}]}});
 const recovered=await recovery.make().processNext();
 assert.equal(recovered.runtime_status,'memory_dream_reconciliation_required');
 assert.equal(recovery.calls.session,0);
 assert.deepEqual(recovery.calls.hold,['usage_unsettled']);
});

test('an unresolved recovery is deferred so the idle worker can examine other due policies',async()=>{
 const f=fixture({enabled:true,candidate:{policy,mode:'recovery',run_id:'run-1'},evidence:{...baseEvidence,budget_attempts:[{state:'unknown',bound_exceeded:false}]}}),pump=f.make();
 const first=await pump.processNext();assert.equal(first.runtime_status,'memory_dream_reconciliation_required');
 assert.equal(await pump.processNext(),null);assert.equal(f.calls.claim,1);assert.equal(f.calls.read,1);
});

test('cancellation or a stale policy epoch cannot finalize even a committed proposal',async t=>{
 for(const failure of ['memory_dream_run_cancelled','memory_dream_policy_stale']){
  await t.test(failure,async()=>{
   const f=fixture({enabled:true,sessionBehavior:async({tools,state})=>{await tools.list();const staged=await tools.stage({memory_ids:['memory-1']});await tools.propose(staged.consolidation_id,{expected_version:1,summary:'Synthetic proposal',changes:[]});state.currentError=failure;}});
   const result=await f.make().processNext();
   assert.equal(result.runtime_status,'memory_dream_reconciliation_required');
   assert.equal(f.calls.proposed,0);
   assert.equal(f.calls.session,1);
   assert.deepEqual(f.calls.hold,['identity_stale']);
  });
 }
});

test('an interrupted run without a committed proposal is held and never restarted',async()=>{
 const evidence={...baseEvidence,consolidation:null,budget_attempts:[{state:'settled',bound_exceeded:false}]};
 const f=fixture({enabled:true,evidence,sessionBehavior:async()=>{throw new Error('interrupted_before_proposal');}});
 const result=await f.make().processNext();
 assert.equal(result.runtime_status,'memory_dream_reconciliation_required');
 assert.equal(f.calls.session,1);
 assert.equal(f.calls.proposed,0);
 assert.deepEqual(f.calls.hold,['proposal_uncommitted']);
});

test('an unexpected applied consolidation state is treated as a boundary violation',async()=>{
 const f=fixture({enabled:true,evidence:{...baseEvidence,consolidation:{...baseEvidence.consolidation,status:'applied'}},sessionBehavior:async()=>{}});
 const result=await f.make().processNext();
 assert.equal(result.runtime_status,'memory_dream_reconciliation_required');
 assert.equal(f.calls.proposed,0);
 assert.deepEqual(f.calls.hold,['apply_observed']);
});

test('a stale source snapshot cannot finalize a persisted proposal',async()=>{
 const f=fixture({enabled:true,evidence:{...baseEvidence,source_current:false}});
 const result=await f.make().processNext();
 assert.equal(result.runtime_status,'memory_dream_reconciliation_required');
 assert.equal(f.calls.proposed,0);
 assert.deepEqual(f.calls.hold,['source_or_policy_stale']);
});

test('a successful settled run with no changes advances through the no-proposal port',async()=>{
 const evidence={...baseEvidence,consolidation:null};
 const f=fixture({enabled:true,evidence,sessionBehavior:async()=>{}});
 const result=await f.make().processNext();
 assert.deepEqual(result,{run_id:'run-1',runtime_status:'memory_dream_no_proposal'});
 assert.equal(f.calls.empty,1);
 assert.equal(f.calls.proposed,0);
});
