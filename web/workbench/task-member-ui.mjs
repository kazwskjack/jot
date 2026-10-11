export function taskMemberCanSend(task,occurrence,run,enabled){
 return !!enabled&&task?.status==='active'&&!occurrence?.completion_state&&!!occurrence?.run_id&&run?.run_id===occurrence.run_id&&['queued','starting','running','waiting_user','waiting_approval'].includes(run.status)&&run.error_code!=='SESSION_GOAL_REVIEW_REQUIRED';
}
export function taskMemberRequest(lead,recipient,runId,text,key){
 if(!lead||!recipient||lead.status!=='active'||recipient.status!=='active'||lead.agent_id===recipient.agent_id||lead.workspace_id!==recipient.workspace_id||lead.project_id!==recipient.project_id)throw new Error('请选择同一项目内的其他有效角色');
 if(!text.trim()||text.trim().length>12000||!runId||!key)throw new Error('请填写协作要求');
 return Object.freeze({sender_agent_id:lead.agent_id,recipient_agent_id:recipient.agent_id,text:text.trim(),client_message_id:key,auto_reply:true,max_replies:1,task_run_id:runId});
}
export function taskDelegationRequest(lead,recipient,occurrence,step,key){
 if(!lead||!recipient||lead.status!=='active'||recipient.status!=='active'||lead.agent_id===recipient.agent_id||lead.workspace_id!==recipient.workspace_id||lead.project_id!==recipient.project_id)throw new Error('请选择同一项目内的其他有效角色');
 if(!occurrence?.occurrence_id||!step?.subtask_id||!Number.isSafeInteger(step.version)||step.version<1||!['pending','blocked'].includes(step.status)||!key)throw new Error('请选择尚未派发的子任务');
 return Object.freeze({occurrence_id:occurrence.occurrence_id,subtask_id:step.subtask_id,expected_subtask_version:step.version,recipient_agent_id:recipient.agent_id,client_message_id:key});
}
