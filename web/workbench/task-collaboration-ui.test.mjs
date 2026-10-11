import test from 'node:test';
import assert from 'node:assert/strict';
test('owner selects only an active same-project team containing the lead and bounds automatic dispatch',async()=>{
 const {eligibleCollaborationTeams,collaborationRequest}=await import('./task-collaboration-ui.mjs');
 const lead={agent_id:'lead',status:'active',workspace_id:'ws',project_id:'p'},member={...lead,agent_id:'member'};
 const team={team_id:'team',status:'active',workspace_id:'ws',project_id:'p',member_ids:['lead','member']};
 assert.deepEqual(eligibleCollaborationTeams(lead,[team,{...team,team_id:'other',project_id:'q'},{...team,team_id:'missing',member_ids:['member']}]),[team]);
 const input=collaborationRequest(0,true,lead,team,[member],['member'],3,1);
 assert.deepEqual(input,{expected_version:0,enabled:true,team_id:'team',member_ids:['member'],max_delegations:3,max_active:1});assert.ok(Object.isFrozen(input));assert.ok(Object.isFrozen(input.member_ids));
 for(const ids of [['lead'],['missing'],['member','member'],[]])assert.throws(()=>collaborationRequest(0,true,lead,team,[member],ids,3,1));
 assert.throws(()=>collaborationRequest(0,true,lead,team,[member],['member'],21,1));
 assert.throws(()=>collaborationRequest(0,true,lead,team,[member],['member'],3,3));
 assert.deepEqual(collaborationRequest(2,false,null,null,[],[],0,0),{expected_version:2,enabled:false});
});
