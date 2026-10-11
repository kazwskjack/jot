const waitingReasons=new Set(['SESSION_GOAL_WAITING_USER','SESSION_GOAL_PAUSED','SESSION_GOAL_BLOCKED','SESSION_GOAL_DISARMED','SESSION_GOAL_ROUND_LIMIT','SESSION_GOAL_BUDGET_EXHAUSTED','SESSION_GOAL_BUDGET_UNCONFIGURED','SESSION_GOAL_STREAM_ENDED']);
export function taskRunCanResume(run,expectedRunId,enabled){
 if(!enabled||!run||run.run_id!==expectedRunId||!Number.isSafeInteger(run.version)||run.version<1||typeof run.checkpoint_id!=='string'||!run.checkpoint_id)return false;
 if(['OUTCOME_UNKNOWN','SESSION_GOAL_USAGE_UNKNOWN','SESSION_GOAL_USAGE_PENDING'].includes(run.error_code))return false;
 return ['failed','interrupted'].includes(run.status)||(run.status==='waiting_user'&&waitingReasons.has(run.error_code));
}
const messages={
 SESSION_GOAL_WAITING_USER:'等待你补充信息。进度已保存，可先查看本次对话。',
 SESSION_GOAL_PAUSED:'执行已暂停，进度已保存。',
 SESSION_GOAL_BLOCKED:'执行遇到阻碍。请先查看本次对话，处理后再继续。',
 SESSION_GOAL_DISARMED:'自动执行已停止，进度已保存。',
 SESSION_GOAL_ROUND_LIMIT:'已达到本次任务的轮次上限。请先检查任务范围；恢复不会重置轮次。',
 SESSION_GOAL_BUDGET_EXHAUSTED:'模型额度不足。请先调整额度，再从保存进度继续；已有消耗保持不变。',
 SESSION_GOAL_BUDGET_UNCONFIGURED:'模型额度尚未配置。配置完成后才能继续执行。',
 SESSION_GOAL_STREAM_ENDED:'执行连接已结束，进度已保存。请确认本次对话后再继续。',
 SESSION_GOAL_WAITING_APPROVAL:'等待确认。请在本次对话查看待确认事项。',
 SESSION_GOAL_REVIEW_REQUIRED:'执行已停止，结果仍需确认。任务尚未通过业务验收。',
 TASK_BUSINESS_REVIEW_REQUIRED:'结果已保留，但还没有通过业务验收。请查看执行记录后继续核验。',
 OUTCOME_UNKNOWN:'上次动作或用量尚待核对，暂不能直接继续，避免重复执行。',
 SESSION_GOAL_USAGE_UNKNOWN:'上次模型用量尚待核对，暂不能直接继续。',
 SESSION_GOAL_USAGE_PENDING:'模型用量仍在核对中，暂不能直接继续。',
};
export function taskRunMessage(run){return messages[run?.error_code]??(run?.status==='waiting_approval'?'等待确认。请查看本次对话。':run?.status==='waiting_user'?'等待补充信息。请查看本次对话。':'');}
export function taskResumeError(error){
 const code=error?.message;
 if(code==='TASK_WAIT_RESPONSE_REQUIRED')return '请打开本次对话，填写补充信息或确认卡片后继续。';
 if(error?.status===409&&['RUN_VERSION_CONFLICT','RUN_STATE_CONFLICT','TASK_CONTINUATION_CONFLICT','CHECKPOINT_INVALID','TASK_CHECKPOINT_UNAVAILABLE'].includes(code))return '执行状态已更新，请刷新后的当前进度再试。';
 if(['RECONCILIATION_REQUIRED','BUDGET_USAGE_UNKNOWN'].includes(code))return '上次动作或用量尚待核对，暂不能继续。';
 if(['MODEL_BUDGET_EXHAUSTED','BUDGET_EXHAUSTED','BUDGET_UNCONFIGURED','TASK_BUDGET_EXHAUSTED'].includes(code))return '当前额度不足或尚未配置，请先检查模型预算。';
 if(code==='TASK_CONTINUATION_LIMIT')return '本次执行已达到恢复次数上限，不能重置进度继续。';
 if(error?.status===403||error?.status===404)return '当前执行不可访问，请刷新执行记录。';
 return '尚未确认恢复结果。请重试同一次恢复请求，或刷新执行记录查看进展。';
}
