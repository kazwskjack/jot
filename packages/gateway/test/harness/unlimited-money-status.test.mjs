import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTaskGoalStatus,taskGoalStopReason} from '../../src/harness/task-goal-status.ts';
const state=()=>({protocol:1,host_status:'idle',goal:{goal_id:'owned-goal',goal_revision:1,phase:'active',activation:'armed',rounds_started:1,max_goal_rounds:5},task:{run_status:'running',business_state:'executing',steps:{total:1,completed:0,evidence_verified:0,all_completed:false,all_execution_evidence_verified:false},budget:{configured:true,pending_unknown:0,pending_in_flight:0,balances:[{scope_id:'owned-root',limits:{tokens:'200',nano_usd:null,model_calls:'5'},used:{tokens:'40',nano_usd:'900719925474099100000',model_calls:'1'},held:{tokens:'0',nano_usd:'0',model_calls:'0'}}]}}});
test('native continuation accepts unlimited money with exact usage and still enforces call limits',()=>{
 const value=state();const parsed=validateTaskGoalStatus({state:value});assert.equal(taskGoalStopReason(parsed,true),undefined);
 parsed.task.budget.balances[0].used.model_calls='5';assert.equal(taskGoalStopReason(parsed,true),'SESSION_GOAL_BUDGET_EXHAUSTED');
});
test('only a monetary limit can be null; used, held and token/call limits remain required numbers',()=>{
 for(const [group,field] of [['used','nano_usd'],['held','nano_usd'],['limits','tokens'],['limits','model_calls']]){
  const value=state();value.task.budget.balances[0][group][field]=null;assert.throws(()=>validateTaskGoalStatus({state:value}),/goal_status_invalid/);
 }
 const value=state();value.task.budget.pending_unknown=1;assert.equal(taskGoalStopReason(validateTaskGoalStatus({state:value}),true),'SESSION_GOAL_USAGE_UNKNOWN');
});
