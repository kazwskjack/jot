export function eligibleCollaborationTeams(lead,teams){
 return lead?.status==='active'?teams.filter(t=>t.status==='active'&&t.workspace_id===lead.workspace_id&&t.project_id===lead.project_id&&t.member_ids?.includes(lead.agent_id)):[];
}
export function collaborationRequest(version,enabled,lead,team,agents,ids,maximum,active){
 if(!Number.isSafeInteger(version)||version<0)throw new Error('请先读取当前授权');
 if(!enabled)return Object.freeze({expected_version:version,enabled:false});
 if(!eligibleCollaborationTeams(lead,[team].filter(Boolean)).length||!Array.isArray(ids)||ids.length<1||ids.length>2||new Set(ids).size!==ids.length
  ||ids.some(id=>id===lead.agent_id||!team.member_ids.includes(id)||!agents.some(a=>a.agent_id===id&&a.status==='active'&&a.workspace_id===lead.workspace_id&&a.project_id===lead.project_id)))throw new Error('请选择团队内的一至两名其他角色');
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>20||![1,2].includes(active))throw new Error('请设置有效的派工上限');
 return Object.freeze({expected_version:version,enabled:true,team_id:team.team_id,member_ids:Object.freeze([...ids]),max_delegations:maximum,max_active:active});
}
