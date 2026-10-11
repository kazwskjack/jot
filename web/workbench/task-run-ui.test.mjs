import test from 'node:test';
import assert from 'node:assert/strict';

// Missing waiting-state admission must leave the user unable to continue;
// accepting stale/unknown/approval records must never produce a resume request.
test('resume is scoped to the current saved run and never treats review or unknown outcomes as permission',async()=>{
 const {taskRunCanResume}=await import('./task-run-ui.mjs');
 const run={run_id:'run-current',status:'waiting_user',version:3,checkpoint_id:'checkpoint-owned',error_code:'SESSION_GOAL_WAITING_USER'};
 assert.equal(taskRunCanResume(run,'run-current',true),true);
 for(const [candidate,id,enabled] of [
  [run,'old-run',true],[run,'run-current',false],
  [{...run,checkpoint_id:undefined},'run-current',true],
  [{...run,version:0},'run-current',true],
  [{...run,version:'3'},'run-current',true],
  [{...run,error_code:undefined},'run-current',true],
  [{...run,error_code:'OUTCOME_UNKNOWN'},'run-current',true],
  [{...run,status:'waiting_approval',error_code:'SESSION_GOAL_REVIEW_REQUIRED'},'run-current',true],
  [{...run,status:'running'},'run-current',true],
  [{...run,status:'succeeded'},'run-current',true],
  [{...run,status:'cancelled'},'run-current',true],
 ])assert.equal(taskRunCanResume(candidate,id,enabled),false);
 for(const status of ['failed','interrupted'])assert.equal(taskRunCanResume({...run,status,error_code:'SESSION_TURN_INTERRUPTED'},'run-current',true),true);
});

test('waiting explanations distinguish user input, depleted budget, review and unknown effects without leaking internal IDs',async()=>{
 const {taskRunMessage}=await import('./task-run-ui.mjs');
 const texts=['SESSION_GOAL_WAITING_USER','SESSION_GOAL_BUDGET_EXHAUSTED','SESSION_GOAL_ROUND_LIMIT','SESSION_GOAL_REVIEW_REQUIRED','OUTCOME_UNKNOWN'].map(error_code=>taskRunMessage({status:'waiting_user',error_code}));
 assert.equal(new Set(texts).size,5);
 assert.match(texts[0],/补充/);assert.match(texts[1],/额度/);assert.match(texts[2],/轮次/);assert.match(texts[3],/确认/);assert.match(texts[4],/核对/);
 for(const text of texts)assert.doesNotMatch(text,/SESSION_GOAL|session_id|goal_id|完成了/);
});

test('actual model admission errors ask for budget adjustment instead of suggesting an uncertain execution retry',async()=>{
 const {taskResumeError}=await import('./task-run-ui.mjs');
 assert.match(taskResumeError({status:429,message:'MODEL_BUDGET_EXHAUSTED'}),/额度/);
 assert.match(taskResumeError({status:409,message:'BUDGET_USAGE_UNKNOWN'}),/核对/);
 assert.match(taskResumeError({status:409,message:'RUN_VERSION_CONFLICT'}),/状态已更新/);
 assert.match(taskResumeError({status:409,message:'TASK_WAIT_RESPONSE_REQUIRED'}),/对话.*卡片/);
 assert.match(taskResumeError({status:502,message:'UPSTREAM_RECEIPT_LOST'}),/尚未确认/);
});
