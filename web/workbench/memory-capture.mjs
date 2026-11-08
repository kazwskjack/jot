export const captureMatches=(value,selection)=>value?.agent_id===selection.agent_id&&value?.project_id===selection.project_id;
export function captureSourceView(source){return {text:source?.available===true&&typeof source.text==='string'?source.text:'',origin:{human:'用户消息',agent:'Agent 回复',automation:'自动任务输入'}[source?.origin]??'消息',truncated:source?.truncated===true};}
export function captureAction(value,action){
 if(!value||!Number.isSafeInteger(value.version)||value.version<1)throw Error('capture_unavailable');
 if(action==='apply'){if(value.status!=='proposed'||!value.policy_current||!value.sources?.length||value.sources.some(source=>source.available!==true))throw Error('capture_unavailable');}
 else if(action!=='reject'||!['watching','ready','proposed'].includes(value.status))throw Error('capture_unavailable');
 return {expected_version:value.version};
}
export function capturePolicyInput(policy,enabled,assistant,automation){if(!Number.isSafeInteger(policy?.version)||policy.version<0||[enabled,assistant,automation].some(value=>typeof value!=='boolean'))throw Error('capture_unavailable');return {expected_version:policy.version,mode:enabled?'suggest':'off',include_assistant:assistant,include_automation:automation};}
export function captureReconcileInput(capture,recovery,epoch,evidence){
 const binding=recovery?.capture_binding;
 const receipt=Array.isArray(recovery?.reconciliation_evidence)?recovery.reconciliation_evidence.find(item=>item?.attempt_id===evidence?.attempt_id&&item?.evidence_ref===evidence?.evidence_ref):null;
 if(!capture||!['ready','proposed','no_notes','rejected'].includes(capture.status)||!Number.isSafeInteger(capture.version)||capture.version<1||!Number.isSafeInteger(capture.policy_version)||capture.policy_version<0||
  !recovery||recovery.capture_status!==capture.status||!['interrupted','failed','cancelled','succeeded','partial'].includes(recovery.processor_run_status)||recovery.proposal_available!==false||!['held_unknown','held_in_flight','held_mixed','unresolved'].includes(recovery.usage_state)||!['unresolved_usage_held','budget_bound_exceeded','source_or_policy_stale'].includes(recovery.recovery_state)||
  !Number.isSafeInteger(epoch)||epoch<0||typeof evidence?.attempt_id!=='string'||!evidence.attempt_id||typeof evidence.evidence_ref!=='string'||!evidence.evidence_ref||!receipt||
  (binding&&(binding.capture_id!==capture.capture_id||binding.agent_id!==capture.agent_id||binding.workspace_id!==capture.workspace_id||binding.project_id!==capture.project_id||binding.version!==capture.version||binding.policy_version!==capture.policy_version||binding.epoch!==epoch||receipt.policy_version!==binding.policy_version||receipt.epoch!==binding.epoch)))throw Error('capture_unavailable');
 return {expected_capture_version:capture.version,expected_policy_version:capture.policy_version,expected_epoch:epoch,attempt_id:evidence.attempt_id,evidence_ref:evidence.evidence_ref};
}
