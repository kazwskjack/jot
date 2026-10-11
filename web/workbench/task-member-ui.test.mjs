import test from 'node:test';
import assert from 'node:assert/strict';
test('member dispatch is scoped to current lead and preserves exact request when retrying',async()=>{
 const {taskMemberRequest,taskMemberCanSend}=await import('./task-member-ui.mjs');
 const lead={agent_id:'lead',workspace_id:'ws',project_id:'p',status:'active'},recipient={...lead,agent_id:'reviewer'};
 const task={agent_id:'lead',status:'active'},occurrence={run_id:'r',completion_state:undefined},run={run_id:'r',status:'running'};
 assert.equal(taskMemberCanSend(task,occurrence,run,true),true);
 for(const changed of [{...run,run_id:'old'},{...run,status:'succeeded'}])assert.equal(taskMemberCanSend(task,occurrence,changed,true),false);
 assert.equal(taskMemberCanSend({...task,status:'paused'},occurrence,run,true),false);
 assert.equal(taskMemberCanSend(task,{...occurrence,completion_state:'finalizing'},run,true),false);
 const request=taskMemberRequest(lead,recipient,'r','  Review findings  ','key');
 assert.equal(request.text,'Review findings');assert.equal(request.task_run_id,'r');assert.equal(request.max_replies,1);
 assert.throws(()=>taskMemberRequest(lead,{...recipient,project_id:'other'},'r','review','key'));
 assert.throws(()=>taskMemberRequest(lead,lead,'r','review','key'));
 assert.ok(Object.isFrozen(request));
});
test('delegation uses the existing frozen step version without accepting task identity or a new objective',async()=>{
 const {taskDelegationRequest}=await import('./task-member-ui.mjs');
 const lead={agent_id:'lead',workspace_id:'ws',project_id:'p',status:'active'},member={...lead,agent_id:'member'},step={subtask_id:'step',version:3,status:'pending'};
 const request=taskDelegationRequest(lead,member,{occurrence_id:'occurrence'},step,'same-key');
 assert.deepEqual(request,{occurrence_id:'occurrence',subtask_id:'step',expected_subtask_version:3,recipient_agent_id:'member',client_message_id:'same-key'});
 assert.ok(Object.isFrozen(request));
 assert.throws(()=>taskDelegationRequest(lead,member,{occurrence_id:'occurrence'},{...step,status:'running'},'key'));
 assert.throws(()=>taskDelegationRequest(lead,{...member,project_id:'other'},{occurrence_id:'occurrence'},step,'key'));
});
