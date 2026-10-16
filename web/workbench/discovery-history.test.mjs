import test from 'node:test';import assert from 'node:assert/strict';
import {discoveryCyclePresentation,discoveryDetailMatches,discoveryCoverage} from './discovery-history.mjs';
const cycle={admission_id:'a',occurrence_id:'o',task_id:'t',signal_revision:3,created_at:'2026-10-17T00:00:00Z',run:{run_id:'r',status:'succeeded',business_state:'waiting_approval'},report:{outcome:'proposals'},accepted:false};
test('an ended original run or recorded report is never presented as accepted work',()=>{
 const view=discoveryCyclePresentation(cycle);assert.equal(view.run,'执行已结束');assert.equal(view.acceptance,'尚未验收');assert.equal(view.business,'等待审核');
 assert.equal(discoveryCyclePresentation({...cycle,accepted:true}).acceptance,'原验收已完成');
 for(const status of ['queued','running','interrupted','failed','succeeded'])assert.equal(discoveryCyclePresentation({...cycle,run:{...cycle.run,status}}).acceptance,'尚未验收');
 assert.equal(discoveryCyclePresentation({...cycle,run:{...cycle.run,status:'unknown',business_state:'unknown'}}).run,'执行状态待核对');
});
test('history details must match the selected original admission and non-authorizing response contract',()=>{
 const value={cycle,plans:[],report:null,next_after_plan_id:null,execution_authorized:false};assert.equal(discoveryDetailMatches(value,'a'),true);
 for(const changed of [{cycle:{...cycle,admission_id:'b'}},{execution_authorized:true},{plans:null},{cycle:null}])assert.equal(discoveryDetailMatches({...value,...changed},'a'),false);
});
test('source coverage distinguishes complete, partial and unavailable counts without guessing reads',()=>{
 assert.equal(discoveryCoverage({signal_count:3,fully_read:2}),'完整读取 2 / 3 条来源');assert.equal(discoveryCoverage({signal_count:0,fully_read:0}),'完整读取 0 / 0 条来源');
 for(const value of [null,{signal_count:3,fully_read:4},{signal_count:3,fully_read:-1},{signal_count:3}])assert.equal(discoveryCoverage(value),'来源覆盖待核对');
});
