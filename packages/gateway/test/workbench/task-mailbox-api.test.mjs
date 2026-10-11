import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './task-wait-fixture.mjs';

test('public owner request binds task mailbox without accepting a foreign root or reinterpreting a duplicate key',async t=>{
 const f=await fixture(t),context=f.workbench.contextForRun(f.runId),role=f.workbench.createAgent('alice',{name:'Reviewer',workspace_id:'ws',project_id:context.project_id});
 const payload={sender_agent_id:context.agent_id,recipient_agent_id:role.agent_id,text:'Review current task',client_message_id:'api-task-review',auto_reply:true,max_replies:1,task_run_id:f.runId};
 const response=await f.send('/v1/workspaces/ws/agent-messages',payload);assert.equal(response.statusCode,201,response.body);
 const msg=response.json();assert.equal(f.db.prepare('SELECT root_run_id FROM wb_mailbox_task_roots WHERE thread_id=?').get(msg.thread_id).root_run_id,f.runId);
 const duplicate=await f.send('/v1/workspaces/ws/agent-messages',payload);assert.equal(duplicate.statusCode,201);assert.equal(duplicate.json().message_id,msg.message_id);
 const changed=await f.send('/v1/workspaces/ws/agent-messages',{...payload,task_run_id:'run-foreign'}, {'idempotency-key':'changed-task-root'});assert.equal(changed.statusCode,409,changed.body);
 const before=f.db.prepare('SELECT count(*) n FROM wb_agent_messages').get().n;
 const invalid=await f.send('/v1/workspaces/ws/agent-messages',{...payload,client_message_id:'new-foreign',task_run_id:'run-foreign'},{'idempotency-key':'foreign-task-root'});assert.equal(invalid.statusCode,422,invalid.body);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_agent_messages').get().n,before);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_mailbox_task_roots').get().n,1);
});

test('task occurrence message history excludes independent threads and enforces owner scope even after pause',async t=>{
 const f=await fixture(t),role=f.workbench.createAgent('alice',{name:'Reviewer',workspace_id:'ws',project_id:f.a.project_id});
 const input={sender_agent_id:f.a.agent_id,recipient_agent_id:role.agent_id,text:'Review task',client_message_id:'scoped',auto_reply:true,task_run_id:f.runId};
 const message=f.workbench.sendMessage('alice','ws',input);
 f.workbench.sendMessage('alice','ws',{...input,task_run_id:undefined,auto_reply:false,client_message_id:'independent',text:'Unrelated'});
 const url=`/v1/workspaces/ws/agent-messages?occurrence_id=${f.occurrence.occurrence_id}`;
 const read=()=>f.app.inject({url,headers:{'x-user-id':'alice'}});
 let response=await read();assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json().items.map(x=>x.message_id),[message.message_id]);
 f.db.prepare("UPDATE wb_persistent_tasks SET status='paused' WHERE task_id=?").run(f.task.task_id);
 response=await read();assert.deepEqual(response.json().items.map(x=>x.message_id),[message.message_id]);
 const foreign=await f.app.inject({url,headers:{'x-user-id':'bob'}});assert.equal(foreign.statusCode,404,foreign.body);
 const unknown=await f.app.inject({url:url+'&session_id=forged',headers:{'x-user-id':'alice'}});assert.equal(unknown.statusCode,422,unknown.body);
});
