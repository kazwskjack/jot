import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './task-wait-fixture.mjs';
import {TaskDelegationService} from '../../src/workbench/task-delegation.ts';
import {WorkbenchBridge} from '../../../session-adapter/workbench.js';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {DatabaseSync} from 'node:sqlite';
import {taskAssignmentForMessage} from '../../src/workbench/task-delegation.ts';

async function setup(t){
 const f=await fixture(t),module=await import('../../src/workbench/task-collaboration.ts').catch(()=>({}));
 assert.equal(typeof module.TaskCollaborationService,'function');
 const member=f.workbench.createAgent('alice',{name:'Authorized member',workspace_id:'ws',project_id:f.a.project_id});
 const outsider=f.workbench.createAgent('alice',{name:'Other member',workspace_id:'ws',project_id:f.a.project_id});
 const team=f.workbench.createTeam('alice',{name:'Research team',workspace_id:'ws',project_id:f.a.project_id,member_ids:[f.a.agent_id,member.agent_id]});
 const service=new module.TaskCollaborationService(f.db,f.workbench,f.persistentTasks,new TaskDelegationService(f.db,f.workbench,f.persistentTasks));
 const step=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Review authorized material'},f.runId);
 const args={subtask_id:step.subtask_id,expected_subtask_version:step.version,recipient_agent_id:member.agent_id,client_message_id:'automatic-1'};
 const policy={expected_version:0,enabled:true,team_id:team.team_id,member_ids:[member.agent_id],max_delegations:1,max_active:1};
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.runId);
 const internal=(name,payload)=>f.app.inject({method:'POST',url:`/internal/v1/workbench/${name}`,headers:{authorization:'Bearer test-b99992d64419ae59'},payload});
 return {...f,service,member,outsider,team,step,args,policy,internal,identity:{run_id:f.runId,session_ref:'session-fixture'}};
}
test('lead delegation requires explicit owner authorization and cannot choose another member or exceed the occurrence cap',async t=>{
 const f=await setup(t);assert.equal(f.service.get('alice',f.task.task_id).enabled,false);
 assert.throws(()=>f.service.delegateByLead('alice',f.runId,f.args),/task_collaboration_forbidden/);
 const saved=f.service.save('alice',f.task.task_id,f.policy);assert.equal(saved.version,1);
 assert.throws(()=>f.service.save('bob',f.task.task_id,f.policy),/task_not_found/);
 assert.throws(()=>f.service.delegateByLead('alice',f.runId,{...f.args,recipient_agent_id:f.outsider.agent_id}),/task_collaboration_forbidden/);
 const receipt=f.service.delegateByLead('alice',f.runId,f.args);assert.deepEqual(f.service.delegateByLead('alice',f.runId,f.args),receipt);
 const next=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Second step'},f.runId);
 assert.throws(()=>f.service.delegateByLead('alice',f.runId,{...f.args,subtask_id:next.subtask_id,expected_subtask_version:next.version,client_message_id:'second'}),/task_collaboration_exhausted/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_agent_messages').get().n,1);
});
test('revoking a grant or changing team membership fences old member execution and does not reset spent delegation slots',async t=>{
 const f=await setup(t);f.service.save('alice',f.task.task_id,f.policy);const receipt=f.service.delegateByLead('alice',f.runId,f.args);f.workbench.processMailbox();
 const child=f.db.prepare('SELECT run_id FROM wb_agent_messages WHERE message_id=?').get(receipt.message_id).run_id;
 f.service.save('alice',f.task.task_id,{expected_version:1,enabled:false});
 assert.throws(()=>f.workbench.assertRunActive(child),/task_collaboration_revoked/);
 f.service.save('alice',f.task.task_id,{...f.policy,expected_version:2});
 const step=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Cannot reset quota'},f.runId);
 assert.throws(()=>f.service.delegateByLead('alice',f.runId,{...f.args,subtask_id:step.subtask_id,expected_subtask_version:step.version,client_message_id:'quota-reset'}),/task_collaboration_exhausted/);
 f.workbench.updateTeam('alice',f.team.team_id,{expected_version:f.team.version,member_ids:[f.a.agent_id]});
 assert.throws(()=>f.service.delegateByLead('alice',f.runId,{...f.args,client_message_id:'changed-team'}),/task_collaboration_revoked/);
});

test('the authenticated DSH tool rechecks authorization on replay and returns a bounded exhaustion error',async t=>{
 const f=await setup(t);f.service.save('alice',f.task.task_id,f.policy);
 const {client_message_id,...args}=f.args;
 const call={...f.identity,operation:'tasks.delegate',call_id:'delegate-first',arguments:args};
 const first=await f.internal('tool',call);assert.equal(first.statusCode,200,first.body);
 const replay=await f.internal('tool',call);assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),first.json());
 const next=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Beyond authorized cap'},f.runId);
 const exhausted=await f.internal('tool',{...call,call_id:'delegate-second',arguments:{...args,subtask_id:next.subtask_id,expected_subtask_version:next.version}});
 assert.equal(exhausted.statusCode,429,exhausted.body);
 assert.equal(exhausted.json().error.code,'TASK_COLLABORATION_EXHAUSTED');
 f.service.save('alice',f.task.task_id,{expected_version:1,enabled:false});
 const revoked=await f.internal('tool',call);assert.equal(revoked.statusCode,403,revoked.body);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_agent_messages').get().n,1);
});

test('owner collaboration settings have a public contract, isolate owners and reject forged identity before saving',async t=>{
 const f=await setup(t),url=`/v1/persistent-tasks/${f.task.task_id}/collaboration`;
 const get=await f.app.inject({url,headers:{'x-user-id':'alice'}});assert.equal(get.statusCode,200,get.body);assert.equal(get.json().enabled,false);
 const saved=await f.app.inject({method:'PATCH',url,headers:f.headers,payload:f.policy});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().version,1);
 const stale=await f.app.inject({method:'PATCH',url,headers:{...f.headers,'idempotency-key':'stale-settings'},payload:f.policy});assert.equal(stale.statusCode,409,stale.body);
 const foreign=await f.app.inject({url,headers:{'x-user-id':'bob'}});assert.equal(foreign.statusCode,404,foreign.body);
 const injected=await f.app.inject({method:'PATCH',url,headers:{...f.headers,'idempotency-key':'forged-settings'},payload:{expected_version:1,enabled:false,owner_id:'bob'}});
 assert.equal(injected.statusCode,400,injected.body);assert.equal(f.service.get('alice',f.task.task_id).version,1);
 const csrf=await f.app.inject({method:'PATCH',url,headers:{'x-user-id':'alice',origin:'https://fixture.invalid'},payload:{expected_version:1,enabled:false}});assert.equal(csrf.statusCode,403,csrf.body);
});

test('sequential authorization keeps the second assignment queued without allocating another member run',async t=>{
 const f=await setup(t);f.service.save('alice',f.task.task_id,{...f.policy,max_delegations:2});
 const first=f.service.delegateByLead('alice',f.runId,f.args);
 const step=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Second authorized assignment'},f.runId);
 const second=f.service.delegateByLead('alice',f.runId,{...f.args,subtask_id:step.subtask_id,expected_subtask_version:step.version,client_message_id:'second-authorized'});
 for(let i=0;i<3;i++)f.workbench.processMailbox();
 const row=id=>f.db.prepare('SELECT status,run_id FROM wb_agent_messages WHERE message_id=?').get(id);
 assert.equal(row(first.message_id).status,'processing');assert.ok(row(first.message_id).run_id);
 assert.equal(row(second.message_id).status,'pending');assert.equal(row(second.message_id).run_id,null);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM wb_task_auxiliary_runs WHERE occurrence_id=?').get(f.occurrence.occurrence_id).n,1);
});

test('a real Gateway-backed member bridge reads the shared workspace, cannot mutate or delegate the parent, and returns material once',async t=>{
 const f=await setup(t);f.service.save('alice',f.task.task_id,f.policy);
 const receipt=f.service.delegateByLead('alice',f.runId,f.args);f.workbench.processMailbox();
 const child=f.db.prepare('SELECT run_id FROM wb_agent_messages WHERE message_id=?').get(receipt.message_id).run_id;
 const conversation=f.db.prepare('SELECT conversation_id FROM ga_runs WHERE id=?').get(child).conversation_id,now=new Date().toISOString();
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(conversation,'alice','member-session',now,now);
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(child);
 const tools=new Map(),sections=new Map(),requests=[];
 const agent={ctx:{tools:{presentAs:()=>()=>{},guard:()=>()=>{},register(tool){tools.set(tool.name,tool);return()=>{};}},systemPrompt:{section(s){sections.set(s.name,s);return()=>{};}},on:()=>()=>{}}};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-b99992d64419ae59',fetchImpl:async(url,init)=>{
  requests.push(JSON.parse(init.body));const result=await f.app.inject({method:'POST',url:new URL(url).pathname,headers:init.headers,payload:init.body});return new Response(result.body,{status:result.statusCode,headers:{'content-type':'application/json'}});
 }});
 await bridge.attach(agent,{runId:child,sessionRef:'member-session'});
 assert.ok(sections.get('jot:agent-role').text().includes(f.step.title));
 assert.match(sections.get('jot:agent-role').text(),/不得编辑父任务账本/);
 const execute=(operation,args,key)=>tools.get('jot_workspace').execute({operation,arguments_json:JSON.stringify(args)},{callId:key,signal:new AbortController().signal});
 const files=JSON.parse(await execute('files.list',{},'member-files'));
 assert.ok(files&&typeof files==='object');
 for(const [operation,args] of [['tasks.upsert',{title:'Unauthorized parent edit'}],['tasks.delegate',{subtask_id:f.step.subtask_id,expected_subtask_version:2,recipient_agent_id:f.outsider.agent_id}]])await assert.rejects(execute(operation,args,'forbidden-'+operation.replace('.','-')),/workbench_run_forbidden/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM wb_task_delegations').get().n,1);
 withImmediateTransaction(f.db,()=>{f.runs.appendAssistant(child,'Reviewed material for the lead');f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(child);});
 f.workbench.reconcileBudgets();f.workbench.processMailbox();f.workbench.processMailbox();
 const material=f.workbench.listMessages('alice','ws',undefined,f.occurrence.occurrence_id).items.filter(m=>m.text==='Reviewed material for the lead');assert.equal(material.length,1);
 assert.equal(f.persistentTasks.subtasks('alice',f.task.task_id).items.find(s=>s.subtask_id===f.step.subtask_id).status,'running');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ga_messages WHERE run_id=? AND role='assistant'").get(f.runId).n,0);
 assert.ok(requests.every(r=>r.run_id===child&&r.session_ref==='member-session'));
});

test('a fresh worker database connection verifies delegated prerequisites from persisted receipts',async t=>{
 const f=await setup(t);f.service.save('alice',f.task.task_id,f.policy);
 const write=await f.internal('tool',{...f.identity,operation:'files.write',call_id:'prerequisite-file',arguments:{path:'prerequisite.md',content:'Verified local fixture source',expected_version:0}});assert.equal(write.statusCode,200,write.body);
 const prerequisite=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Gather source',status:'completed',evidence:[write.json().execution_receipt]},f.runId);
 const step=f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Review verified source',dependencies:[prerequisite.subtask_id]},f.runId);
 const receipt=f.service.delegateByLead('alice',f.runId,{...f.args,subtask_id:step.subtask_id,expected_subtask_version:step.version});
 const workerDb=new DatabaseSync(f.fixtureConfig.databasePath);
 try{
  assert.equal(taskAssignmentForMessage(workerDb,'alice',receipt.message_id,true).subtask_id,step.subtask_id);
  workerDb.prepare("UPDATE wb_task_subtasks SET status='blocked' WHERE subtask_id=?").run(prerequisite.subtask_id);
  assert.throws(()=>taskAssignmentForMessage(workerDb,'alice',receipt.message_id,true),/dependency_not_completed/);
 }finally{workerDb.close();}
});
