export const captureMatches=(value,selection)=>value?.agent_id===selection.agent_id&&value?.project_id===selection.project_id;
export function captureSourceView(source){return {text:source?.available===true&&typeof source.text==='string'?source.text:'',origin:{human:'用户消息',agent:'Agent 回复',automation:'自动任务输入'}[source?.origin]??'消息',truncated:source?.truncated===true};}
export function captureAction(value,action){
 if(!value||!Number.isSafeInteger(value.version)||value.version<1)throw Error('capture_unavailable');
 if(action==='apply'){if(value.status!=='proposed'||!value.policy_current||!value.sources?.length||value.sources.some(source=>source.available!==true))throw Error('capture_unavailable');}
 else if(action!=='reject'||!['watching','ready','proposed'].includes(value.status))throw Error('capture_unavailable');
 return {expected_version:value.version};
}
export function capturePolicyInput(policy,enabled,assistant,automation){if(!Number.isSafeInteger(policy?.version)||policy.version<0||[enabled,assistant,automation].some(value=>typeof value!=='boolean'))throw Error('capture_unavailable');return {expected_version:policy.version,mode:enabled?'suggest':'off',include_assistant:assistant,include_automation:automation};}
