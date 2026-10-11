const roleFields=agent=>({name:agent.name,instructions:agent.instructions,allowed_tools:[...agent.allowed_tools]});
export function copyAgentConfig(agent){
 return {...roleFields(agent),name:agent.name.slice(0,97)+' 副本',workspace_id:agent.workspace_id,project_id:agent.project_id};
}
export function exportAgentConfig(agent){
 return {format:'jot-agent-config',version:1,role:roleFields(agent)};
}
export function agentStatusInput(agent){
 if(!['active','disabled'].includes(agent.status)||!Number.isSafeInteger(agent.version)||agent.version<1)throw new Error('角色版本不可用，请刷新列表');
 return {expected_version:agent.version,status:agent.status==='active'?'disabled':'active'};
}
export function downloadAgentConfig(agent){
 const url=URL.createObjectURL(new Blob([JSON.stringify(exportAgentConfig(agent),null,2)+'\n'],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download='jot-agent-config.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
