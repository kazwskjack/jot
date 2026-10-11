import assert from 'node:assert/strict';
import test from 'node:test';
import {readinessPresentation,readinessReason} from './readiness-ui.mjs';
test('stale readiness never displays an old high score or treats a raw score as completion',()=>{
 const result=readinessPresentation({fresh:false,display:{readiness_score:99,business_status:'completed',completion_confirmed:false},latest:{model_raw_score:0.99,uncertainty_reasons:['evidence_missing:source']},stale_reasons:['assessment_expired']});
 assert.equal(result.score,null);assert.equal(result.completion,'已标记完成，执行证据待核验');assert.deepEqual(result.reasons,['评估已过期','需要补充证据：source']);
});
test('fresh readiness is advisory, dependency reasons are readable and unknown diagnostics are bounded',()=>{
 const result=readinessPresentation({fresh:true,display:{readiness_score:60,business_status:'pending',completion_confirmed:false},stale_reasons:[],latest:{uncertainty_reasons:['target_not_unique']}});
 assert.equal(result.score,60);assert.equal(result.completion,null);assert.equal(result.label,'执行准备度，供参考');
 assert.equal(readinessReason('dependency_not_completed:subtask-test'),'等待前置任务完成：subtask-test');assert.equal(readinessReason('unknown:private-value'),'需要进一步确认');
});
