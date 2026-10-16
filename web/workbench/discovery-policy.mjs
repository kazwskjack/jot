// Presentation/input helpers only. The original Gateway rechecks owner, role,
// policy revision, budgets and native occupancy before any task admission.
function positive(value){return Number.isSafeInteger(value)&&value>0;}
function role(agent){if(!agent||!['agent_id','project_id','workspace_id'].every(key=>typeof agent[key]==='string'&&agent[key].length>0)||!positive(agent.version)||!positive(agent.capability_epoch))throw Error('角色信息尚未就绪，请重新读取。');}
export function discoveryScope(ownerScope,agent){role(agent);if(!/^[a-f0-9]{64}$/.test(ownerScope??''))throw Error('用户范围尚未就绪，请重新读取工作台。');return JSON.stringify([ownerScope,agent.workspace_id,agent.project_id,agent.agent_id,agent.version,agent.capability_epoch]);}
export function discoveryPolicyMatches(policy,agent){return !!policy&&positive(policy.version)&&['agent_id','project_id','workspace_id'].every(key=>policy.scope?.[key]===agent?.[key]);}
function owned(policy,agent){role(agent);if(policy!==null&&!discoveryPolicyMatches(policy,agent))throw Error('策略归属已变化，请重新读取。');}
export function discoveryPolicyForm(policy){return {cooldown_seconds:String((policy?.cooldown_ms??300000)/1000),recent_input_seconds:String((policy?.recent_input_ms??60000)/1000),max_cycles:policy?.max_cycles==null?'':String(policy.max_cycles)};}
function integer(text,min,multiple=1){if(typeof text!=='string'||!/^\d+$/.test(text))throw Error('请填写完整的非负整数。');const value=Number(text)*multiple;if(!Number.isSafeInteger(value)||value<min)throw Error('数值不在支持的范围内。');return value;}
export function discoveryPolicyInput(agent,policy,form){
 owned(policy,agent);if(policy&&policy.mode!=='discover_only')throw Error('当前策略包含工作执行模式，请先核对原配置。');
 return {expected_version:policy?.version??0,expected_role_version:agent.version,expected_role_epoch:agent.capability_epoch,mode:'discover_only',cooldown_ms:integer(form.cooldown_seconds,0,1000),recent_input_ms:integer(form.recent_input_seconds,0,1000),max_cycles:form.max_cycles===''?null:integer(form.max_cycles,1)};
}
export function discoveryControlInput(agent,policy,action){
 owned(policy,agent);if(!policy||!['enable','pause','stop'].includes(action))throw Error('请先保存并重新读取策略。');
 if(action==='enable'&&(agent.status!=='active'||policy.role_version!==agent.version||policy.role_epoch!==agent.capability_epoch))throw Error('角色权限已变化，请重新保存策略后再启用。');
 return {action,expected_version:policy.version,...(action==='enable'?{expected_role_version:agent.version,expected_role_epoch:agent.capability_epoch}:{})};
}
