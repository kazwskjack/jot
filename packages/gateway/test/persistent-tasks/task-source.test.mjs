import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {buildServer} from '../../src/server.ts';
import {ProjectRepository} from '../../src/projects/repository.ts';
function fixture(t){const db=openProductDatabase(':memory:');t.after(()=>db.close());const workbench=new WorkbenchService(db,{workspaceIds:['shared'],root:'.test-tmp/task-source'});const tasks=new PersistentTaskService(db,workbench);const conversations=new ConversationRepository(db),runs=new RunRepository(db,new EventStore(db));const agent=workbench.createAgent('alice',{name:'Reader',workspace_id:'shared'});return {db,tasks,agent,conversations,runs};}
test('persistent task source freezes owned message identity and server-calculated content hash',t=>{
 const f=fixture(t);const receipt=f.runs.enqueue(f.agent.conversation_id,'alice',{client_message_id:'source',content:[{type:'text',text:'Watch the public page'}]});
 const input={title:'Watch',agent_id:f.agent.agent_id,objective:'Watch the page',trigger:{kind:'once'},source:{conversation_id:f.agent.conversation_id,message_id:receipt.message_id}};
 const task=f.tasks.create('alice',input,'source-request');assert.deepEqual(Object.keys(task.source).sort(),['content_sha256','conversation_id','message_id']);assert.match(task.source.content_sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(f.tasks.create('alice',input,'source-request').source,task.source);
 assert.deepEqual(new PersistentTaskService(f.db,{getAgent:()=>f.agent}).get('alice',task.task_id).source,task.source);
 const moving=new PersistentTaskService(f.db,{getAgent:()=>({...f.agent,project_id:'different-project'})});assert.throws(()=>moving.update('alice',task.task_id,{expected_version:1,agent_id:'moved'}),/invalid_task_source/);
 assert.equal(f.tasks.get('alice',task.task_id).version,1);
});
test('foreign owner, unrelated messages, extra authority fields and missing messages are rejected atomically',t=>{
 const f=fixture(t);const foreign=f.conversations.create('bob',{workspace_id:'shared',model:{provider:'harness',model:'automatic'}});const receipt=f.runs.enqueue(foreign.conversation_id,'bob',{client_message_id:'foreign',content:[{type:'text',text:'Private'}]});
 for(const source of [{conversation_id:foreign.conversation_id,message_id:receipt.message_id},{conversation_id:f.agent.conversation_id,message_id:receipt.message_id},{conversation_id:f.agent.conversation_id,message_id:'absent'},{conversation_id:f.agent.conversation_id,message_id:'absent',owner_id:'bob'}])assert.throws(()=>f.tasks.create('alice',{title:'Task',agent_id:f.agent.agent_id,objective:'Task',trigger:{kind:'once'},source}),/invalid_task_source/);
 assert.equal(f.tasks.list('alice').items.length,0);
 const project=new ProjectRepository(f.db).create('alice',{title:'Another project'});const other=f.conversations.create('alice',{workspace_id:'shared',project_id:project.project_id,model:{provider:'harness',model:'automatic'}});
 const another=f.runs.enqueue(other.conversation_id,'alice',{client_message_id:'other-project',content:[{type:'text',text:'Different project'}]});assert.throws(()=>f.tasks.create('alice',{title:'Task',agent_id:f.agent.agent_id,objective:'Task',trigger:{kind:'once'},source:{conversation_id:other.conversation_id,message_id:another.message_id}}),/invalid_task_source/);
});
test('public task creation accepts only owner-verified source references and rejects source mutation',async t=>{
 const service=await buildServer({databasePath:':memory:',workspaces:['shared'],workbenchRoot:'.test-tmp/task-source-api',csrfToken:'test-task-source',allowedOrigins:['https://fixture.invalid']});
 t.after(async()=>{await service.app.close();service.db.close();});const agent=service.workbench.createAgent('alice',{name:'Reader',workspace_id:'shared'});
 const message=service.runs.enqueue(agent.conversation_id,'alice',{client_message_id:'source-api',content:[{type:'text',text:'Watch public information'}]});
 const input={title:'Task',agent_id:agent.agent_id,objective:'Watch',trigger:{kind:'once'},source:{conversation_id:agent.conversation_id,message_id:message.message_id}};
 const headers={'x-user-id':'alice','x-csrf-token':'test-task-source',origin:'https://fixture.invalid','idempotency-key':'test-task-source-request'};
 const response=await service.app.inject({method:'POST',url:'/v1/persistent-tasks',headers,payload:input});assert.equal(response.statusCode,201,response.body);assert.equal(response.json().source.message_id,message.message_id);
 const patch=await service.app.inject({method:'PATCH',url:`/v1/persistent-tasks/${response.json().task_id}`,headers:{...headers,'idempotency-key':'test-mutation'},payload:{expected_version:1,source:input.source}});assert.equal(patch.statusCode,400,patch.body);
});
