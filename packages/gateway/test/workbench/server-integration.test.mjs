import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {SessionCommandDispatcher} from '../../src/harness/command-dispatcher.ts';
import Fastify from 'fastify';
import {registerWorkbenchExecution} from '../../src/workbench/execution.ts';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {ContractValidator} from '../../src/contracts/validator.ts';

const base=resolve(fileURLToPath(new URL('../../../../.test-tmp/workbench-server-integration/',import.meta.url)));
assert.ok(isAbsolute(base),'test fixture root must be resolved before cleanup');
mkdirSync(base,{recursive:true});
const origin='https://fixture.jot.example',csrf='test-fcd665020b8961c8',token='test-75136d825f18f524';

async function fixture(t,overrides={}){
 const root=mkdtempSync(join(base,'case-')),templates=join(root,'templates');mkdirSync(templates);
 const bytes=Buffer.from('controlled template fixture; no document render is requested');writeFileSync(join(templates,'fixture.docx'),bytes);
 writeFileSync(join(templates,'catalog.json'),JSON.stringify({templates:[{template_id:'fixture-template',version:'1',format:'docx',file:'fixture.docx',sha256:createHash('sha256').update(bytes).digest('hex'),fields:{}}]}));
 let service;
 t.after(async()=>{if(service){await service.app.close();service.db.close();}const child=relative(base,resolve(root));assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child),'cleanup target must remain inside the fixture root');rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 service=await buildServer({databasePath:':memory:',workspaces:['main'],uploadRoot:join(root,'uploads'),templateRoot:templates,workbenchRoot:join(root,'shared'),csrfToken:csrf,allowedOrigins:[origin],internalChannelToken:token,
  modelBudgetRoutes:[{provider:'fixture',model:'bounded',revision:'fixture-rates-v1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}}],...overrides});
 const http=async(method,url,payload,owner='alice',key=randomUUID())=>service.app.inject({method,url,payload,headers:{'x-user-id':owner,origin,'x-csrf-token':csrf,'idempotency-key':key}});
 const json=async(method,url,payload,status=200,owner='alice',key)=>{const response=await http(method,url,payload,owner,key);assert.equal(response.statusCode,status,`${method} ${url}: ${response.body}`);return response.json();};
 const agent=async(name,owner='alice')=>json('POST','/v1/agents',{name,instructions:`${name} responsibility`,workspace_id:'main'},201,owner);
 const internal=(path,payload,authorization=`Bearer ${token}`)=>service.app.inject({method:'POST',url:`/internal/v1/workbench/${path}`,headers:authorization?{authorization}:{},payload});
 const bind=(owner,conversationId)=>new SessionBindingRepository(service.db).getOrCreate(owner,conversationId).session_id;
 const countRuns=()=>Number(service.db.prepare('SELECT count(*) n FROM ga_runs').get().n);
 const chat=async(role,message='Research',key=randomUUID())=>json('POST',`/v1/conversations/${role.conversation_id}/messages`,{client_message_id:key,content:[{type:'text',text:message}]},202,'alice',key);
 const executionGuard={assertRunActive:runId=>service.workbench.assertRunActive(runId),contextForRun:runId=>service.workbench.contextForRun(runId),inheritChatRun:(owner,oldRun,nextRun)=>service.workbench.inheritChatRun(owner,oldRun,nextRun)};
 return {...service,root,http,json,agent,internal,bind,countRuns,chat,executionGuard};
}

test('the existing authenticated workspace content route reads the requested immutable version and never falls back to latest',async t=>{
 const f=await fixture(t),a=await f.agent('Version reader');
 const first=f.workbench.writeFile('alice','main',{project_id:a.project_id,path:'report.txt',content:'Reviewed original',expected_version:0});
 f.workbench.writeFile('alice','main',{project_id:a.project_id,path:'report.txt',content:'Latest replacement',expected_version:1});
 const url=`/v1/workspaces/main/files/content?project_id=${encodeURIComponent(a.project_id)}&path=report.txt`;
 const pinned=await f.json('GET',url+'&version=1');assert.equal(pinned.content,'Reviewed original');assert.equal(pinned.sha256,first.sha256);assert.equal(pinned.version,1);
 assert.equal((await f.json('GET',url)).content,'Latest replacement');
 const validator=new ContractValidator(),op=validator.operationFor('GET','/v1/workspaces/{workspace_id}/files/content');
 assert.equal(validator.validateResponse(op,200,pinned).valid,true);
 assert.equal((await f.http('GET',url+'&version=99')).statusCode,404);
 assert.equal((await f.http('GET',url+'&version=1',undefined,'bob')).statusCode,404);
 for(const version of ['0','-1','1.0','1e0','01','9007199254740992','abc'])assert.notEqual((await f.http('GET',url+'&version='+version)).statusCode,200,version);
 assert.notEqual((await f.http('GET',url+'&version=1&version=2')).statusCode,200);
 assert.notEqual((await f.http('GET',url+'&version=1&owner_id=alice')).statusCode,200);
 const row=f.db.prepare('SELECT blob_name FROM wb_file_versions WHERE project_id=? AND version=1').get(a.project_id);
 writeFileSync(join(f.workbench.projectRoot('alice','main',a.project_id),'blobs',row.blob_name),'Corrupt original');
 assert.notEqual((await f.http('GET',url+'&version=1')).statusCode,200);
 assert.equal((await f.json('GET',url)).content,'Latest replacement');
});

test('protected step-admission requires a live owned task and reports a read-only route preview',async t=>{
 const f=await fixture(t),a=await f.agent('Step admission');
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Continue safely',agent_id:a.agent_id,objective:'Complete the authorized work',trigger:{kind:'once'}},201);
 const run=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202);
 const identity={run_id:run.run_id,session_ref:f.bind('alice',run.conversation_id)},route={provider:'fixture',model:'bounded'};
 const call=(extra={},authorization)=>f.internal('step-admission',{...identity,route,...extra},authorization);
 assert.equal((await call({},null)).statusCode,401);
 assert.equal((await call()).statusCode,409,'queued is not admitted as a native model step');
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 assert.equal((await call()).statusCode,503,'missing budget must not grant an automatic step');
 const scope=f.modelBudgets.createScope('alice','step-cap',{tokens:100,nano_usd:1000,model_calls:1});
 f.modelBudgets.bindRun('alice',run.run_id,[scope.scope_id]);f.modelBudgets.admitRun('alice',run.run_id,route);
 const before={balance:f.modelBudgets.balance('alice',scope.scope_id),events:f.db.prepare('SELECT count(*) n FROM wb_model_budget_events').get().n,run:f.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(run.run_id)};
 for(let i=0;i<2;i++){
  const response=await call();assert.equal(response.statusCode,200,response.body);
  const value=response.json();assert.equal(value.context.task_binding.occurrence_id,run.occurrence_id);
  assert.deepEqual(value.admission,{protocol:1,allowed:true,route:{provider:'fixture',model:'bounded',pricing_revision:'fixture-rates-v1',
   reserved:{tokens:'100',nano_usd:'1000',model_calls:'1'},queue_credit:{tokens:'100',nano_usd:'1000',model_calls:'1'}}});
 }
 assert.deepEqual({balance:f.modelBudgets.balance('alice',scope.scope_id),events:f.db.prepare('SELECT count(*) n FROM wb_model_budget_events').get().n,run:f.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(run.run_id)},before);
 for(const extra of [{owner_id:'bob'},{goal_id:'forged'},{route:{...route,attempt_id:'queue-admission'}},{session_ref:f.bind('alice',a.conversation_id)}])
  assert.notEqual((await call(extra)).statusCode,200);
 const held=f.modelBudgets.reserve('alice',run.run_id,{attempt_id:'real-attempt',...route});f.modelBudgets.dispatch('alice',run.run_id,held.attempt_id);
 assert.equal((await call()).json().error.code,'BUDGET_USAGE_PENDING');
 f.modelBudgets.markUnknown('alice',run.run_id,held.attempt_id,'usage_incomplete');
 assert.equal((await call()).json().error.code,'BUDGET_USAGE_UNKNOWN');
 f.modelBudgets.settle('alice',run.run_id,held.attempt_id,{inputTokens:5,outputTokens:5,totalTokens:10});
 assert.equal((await call()).statusCode,429);
 await f.json('POST',`/v1/persistent-tasks/${task.task_id}/pause`,{expected_version:task.version});
 assert.notEqual((await call()).statusCode,200);
});

test('step-admission never admits an ordinary role chat as a persistent Goal',async t=>{
 const f=await fixture(t),a=await f.agent('Ordinary chat'),run=await f.chat(a);
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 const response=await f.internal('step-admission',{run_id:run.run_id,session_ref:f.bind('alice',a.conversation_id),route:{provider:'fixture',model:'bounded'}});
 assert.notEqual(response.statusCode,200);assert.equal(response.json().error.code,'WORKBENCH_TASK_SCOPE_FORBIDDEN');
});

test('protected Goal proposals are CAS bound, durable and cannot turn execution receipts into business acceptance',async t=>{
 const f=await fixture(t),a=await f.agent('Goal proposer');
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Reviewed report',agent_id:a.agent_id,objective:'Write the requested report and have it reviewed',trigger:{kind:'once'}},201);
 const run=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),identity={run_id:run.run_id,session_ref:f.bind('alice',run.conversation_id)};
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 const scope=f.modelBudgets.createScope('alice','proposal-budget',{tokens:500,nano_usd:5000,model_calls:5});f.modelBudgets.bindRun('alice',run.run_id,[scope.scope_id]);
 const goal={goal_id:'proposal-goal',goal_revision:1};assert.equal((await f.internal('goal-binding',{...identity,action:'save',...goal})).statusCode,200);
 const proposal={...identity,...goal,call_id:'complete-proposal',intent:'complete',summary:'The report is ready for your review.'};
 assert.equal((await f.internal('goal-proposal',proposal,null)).statusCode,401);
 const missing=await f.internal('goal-proposal',proposal);assert.equal(missing.statusCode,200,missing.body);
 assert.deepEqual(missing.json().proposal,{accepted:false,reason:'execution_evidence_required'});
 const tool=(operation,args,call_id)=>f.internal('tool',{...identity,operation,arguments:args,call_id});
 const step=(await tool('tasks.upsert',{title:'Report',acceptance:'The report must answer the original request.'},'create-step')).json();
 const written=(await tool('files.write',{path:'review/report.txt',content:'Controlled draft report',expected_version:0},'report-write')).json();
 const completed=await tool('tasks.upsert',{subtask_id:step.subtask_id,expected_version:step.version,status:'completed',evidence:[written.execution_receipt]},'finish-step');assert.equal(completed.statusCode,200,completed.body);
 const accepted=await f.internal('goal-proposal',{...proposal,call_id:'ready-proposal'});assert.equal(accepted.statusCode,200,accepted.body);
 assert.equal(accepted.json().proposal.accepted,true);assert.equal(accepted.json().proposal.action,'review');assert.equal(accepted.json().proposal.goal_id,goal.goal_id);
 assert.equal(f.runs.get(run.run_id,'alice').status,'running','proposal does not release a live worker or mark a run complete');
 assert.equal(f.persistentTasks.occurrences('alice',task.task_id).items[0].business_state,'approval_requested');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_goal_proposals').get().n,1);
 const replay=await f.internal('goal-proposal',{...proposal,call_id:'ready-proposal'});assert.equal(replay.body,accepted.body);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_goal_proposals').get().n,1);
 assert.equal((await f.internal('goal-proposal',{...proposal,call_id:'ready-proposal',intent:'continue',route:{provider:'fixture',model:'bounded'}})).statusCode,409);
 for(const extra of [{goal_revision:2},{goal_id:'other-goal'},{owner_id:'bob'},{max_goal_rounds:1000},{action:'complete'},{intent:'clear'},{intent:['wait_user']},{intent:{toString:'wait_user'}}])
  assert.notEqual((await f.internal('goal-proposal',{...proposal,call_id:randomUUID(),...extra})).statusCode,200);
 assert.equal(f.modelBudgets.balance('alice',scope.scope_id).used.tokens,'0');
});

test('continue and wait proposals retain the original scope and never manufacture another run or final answer',async t=>{
 const f=await fixture(t),a=await f.agent('Continue proposer'),ordinary=await f.chat(a);
 const raw={run_id:ordinary.run_id,session_ref:f.bind('alice',a.conversation_id),goal_id:'proposal-goal',goal_revision:1,call_id:'ordinary',intent:'continue',summary:'Continue',route:{provider:'fixture',model:'bounded'}};
 assert.notEqual((await f.internal('goal-proposal',raw)).statusCode,200);
 f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(ordinary.run_id);
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Continue',agent_id:a.agent_id,objective:'Continue the authorized task',trigger:{kind:'once'}},201);
 const run=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),identity={run_id:run.run_id,session_ref:f.bind('alice',run.conversation_id)};
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 const scope=f.modelBudgets.createScope('alice','continuation-budget',{tokens:100,nano_usd:1000,model_calls:1});f.modelBudgets.bindRun('alice',run.run_id,[scope.scope_id]);
 const goal={goal_id:'continue-goal',goal_revision:1};await f.internal('goal-binding',{...identity,action:'save',...goal});
 const invoke=(intent)=>f.internal('goal-proposal',{...identity,...goal,call_id:`intent-${intent}`,intent,summary:'Continue within the original request',...(intent==='continue'?{route:{provider:'fixture',model:'bounded'}}:{})});
 assert.equal((await invoke('continue')).json().proposal.action,'resume');
 assert.equal((await invoke('wait_user')).json().proposal.action,'pause');
 assert.equal(f.persistentTasks.occurrences('alice',task.task_id).items[0].business_state,'input_requested');
 assert.equal((await invoke('wait_approval')).json().proposal.action,'review');
 assert.equal(f.persistentTasks.occurrences('alice',task.task_id).items[0].business_state,'approval_requested');
 assert.equal(f.countRuns(),2);assert.equal(f.persistentTasks.get('alice',task.task_id).runs_used,1);
 await f.json('POST',`/v1/persistent-tasks/${task.task_id}/pause`,{expected_version:task.version});
 assert.notEqual((await invoke('continue')).statusCode,200);
});

test('protected task-state reports current execution proof and intersecting balances without granting completion or spending',async t=>{
 const f=await fixture(t),a=await f.agent('State observer');
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Verified output',agent_id:a.agent_id,objective:'Create an output and review it',trigger:{kind:'once'},budget:{max_runs:1}},201);
 const run=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),identity={run_id:run.run_id,session_ref:f.bind('alice',run.conversation_id)};
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 const scope=f.modelBudgets.createScope('alice','observation-budget',{tokens:500,nano_usd:5000,model_calls:5});f.modelBudgets.bindRun('alice',run.run_id,[scope.scope_id]);
 const invoke=(operation,args={})=>f.internal('tool',{...identity,operation,arguments:args,call_id:randomUUID()});
 const step=(await invoke('tasks.upsert',{title:'Create output',acceptance:'Read back the expected content'})).json();
 const written=await invoke('files.write',{path:'observation/output.txt',content:'Expected output',expected_version:0});assert.equal(written.statusCode,200,written.body);
 const completed=await invoke('tasks.upsert',{subtask_id:step.subtask_id,expected_version:step.version,status:'completed',evidence:[written.json().execution_receipt]});assert.equal(completed.statusCode,200,completed.body);
 const reserved=f.modelBudgets.reserve('alice',run.run_id,{attempt_id:'state-model',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',run.run_id,reserved.attempt_id);f.modelBudgets.markUnknown('alice',run.run_id,reserved.attempt_id,'usage_incomplete');
 const before={run:f.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(run.run_id),subtasks:f.persistentTasks.subtasks('alice',task.task_id),balance:f.modelBudgets.balance('alice',scope.scope_id),events:f.db.prepare('SELECT count(*) n FROM wb_model_budget_events').get().n};
 const response=await f.internal('task-state',identity);assert.equal(response.statusCode,200,response.body);
 const state=response.json();assert.equal(state.context.task_binding.occurrence_id,run.occurrence_id);
 assert.deepEqual(state.task.steps,{total:1,completed:1,evidence_verified:1,all_completed:true,all_execution_evidence_verified:true});
 assert.equal(state.task.run_status,'running');assert.equal(state.task.budget.configured,true);assert.equal(state.task.budget.pending_unknown,1);assert.equal(state.task.budget.pending_in_flight,0);
 assert.deepEqual(state.task.budget.balances,[before.balance]);assert.equal(state.task.business_state,'queued','read does not silently reconcile a business terminal state');
 assert.equal(state.task.completion_verified,undefined,'execution proof must not be advertised as business acceptance');
 assert.deepEqual({run:f.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(run.run_id),subtasks:f.persistentTasks.subtasks('alice',task.task_id),balance:f.modelBudgets.balance('alice',scope.scope_id),events:f.db.prepare('SELECT count(*) n FROM wb_model_budget_events').get().n},before);
 for(const extra of [{owner_id:'bob'},{goal_id:'forged'},{occurrence_id:'forged'},{session_id:'forged'}])assert.notEqual((await f.internal('task-state',{...identity,...extra})).statusCode,200);
 assert.equal((await f.internal('task-state',identity,null)).statusCode,401);
 assert.notEqual((await f.internal('task-state',{...identity,session_ref:f.bind('alice',a.conversation_id)})).statusCode,200);
 await f.json('POST',`/v1/persistent-tasks/${task.task_id}/pause`,{expected_version:task.version});
 assert.notEqual((await f.internal('task-state',identity)).statusCode,200);
});

test('task-state cannot confuse an empty plan or unverified completed labels with current proof, or serve role chat',async t=>{
 const f=await fixture(t),a=await f.agent('Incomplete state');
 const chat=await f.chat(a);assert.notEqual((await f.internal('task-state',{run_id:chat.run_id,session_ref:f.bind('alice',a.conversation_id)})).statusCode,200);
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Incomplete',agent_id:a.agent_id,objective:'Need evidence',trigger:{kind:'once'}},201);
 const run=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),identity={run_id:run.run_id,session_ref:f.bind('alice',run.conversation_id)};
 const empty=await f.internal('task-state',identity);assert.equal(empty.statusCode,200,empty.body);assert.equal(empty.json().task.steps.all_completed,false);assert.equal(empty.json().task.budget.configured,false);
 f.persistentTasks.upsertSubtask('alice',task.task_id,{title:'A label',status:'completed',evidence:[{kind:'source',reference:'owner bookkeeping'}]});
 const observed=await f.internal('task-state',identity);assert.equal(observed.statusCode,200,observed.body);
 assert.deepEqual(observed.json().task.steps,{total:1,completed:1,evidence_verified:0,all_completed:true,all_execution_evidence_verified:false});
 f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(run.run_id);assert.notEqual((await f.internal('task-state',identity)).statusCode,200);
});

test('configured production API automatically allocates role budgets and rejects excess admission atomically',async t=>{
 const limits=Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,{tokens:100,nano_usd:1000,model_calls:1}]));
 const config={revision:1,admission_route:{provider:'fixture',model:'bounded'},routes:[{provider:'fixture',model:'bounded',revision:'rates-1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}}],limits};
 const f=await fixture(t,{modelBudgetRoutes:undefined,modelBudgetPolicy:config});const a=await f.agent('Budget role'),first=await f.chat(a);
 assert.equal(f.modelBudgets.isBound('alice',first.run_id),true);
 const identity={run_id:first.run_id,session_ref:f.bind('alice',a.conversation_id)};
 assert.deepEqual((await f.internal('guard',identity)).json().context.model_budget,{protocol:1,enforced:true});
 const before=f.countRuns();const denied=await f.http('POST',`/v1/conversations/${a.conversation_id}/messages`,{client_message_id:'over-limit',content:[{type:'text',text:'Extra request'}]});
 assert.equal(denied.statusCode,429,denied.body);assert.equal(denied.json().error.code,'MODEL_BUDGET_EXHAUSTED');assert.equal(f.countRuns(),before);
 const {WorkbenchBudgetPolicy}=await import('../../src/workbench/model-budget-policy.ts');new WorkbenchBudgetPolicy(f.db,{...config,revision:2});
 const stale=await f.http('POST',`/v1/conversations/${a.conversation_id}/messages`,{client_message_id:'stale-process',content:[{type:'text',text:'Stale request'}]});
 assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().error.code,'BUDGET_POLICY_STALE');assert.equal(f.countRuns(),before);
});

test('protected model budget derives owner and scopes from the real run and permits only accounting after revocation',async t=>{
 const f=await fixture(t),a=await f.agent('Budget researcher'),run=await f.chat(a);
 assert.ok(f.modelBudgets,'configured authoritative ledger must be available');
 const identity={run_id:run.run_id,session_ref:f.bind('alice',a.conversation_id)};
 assert.equal((await f.internal('guard',identity)).json().context.model_budget,undefined,'unallocated runs are not presented as budget-enforced');
 const scope=f.modelBudgets.createScope('alice','owner-root',{tokens:500,nano_usd:5000,model_calls:5});f.modelBudgets.bindRun('alice',run.run_id,[scope.scope_id]);
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 assert.deepEqual((await f.internal('guard',identity)).json().context.model_budget,{protocol:1,enforced:true});
 const restarted=Fastify();t.after(()=>restarted.close());registerWorkbenchExecution(restarted,f.db,f.workbench,f.persistentTasks,token);
 const missingConfig=await restarted.inject({method:'POST',url:'/internal/v1/workbench/guard',headers:{authorization:`Bearer ${token}`},payload:identity});
 assert.ok(missingConfig.statusCode>=400,'a restarted host cannot erase budget enforcement by omitting pricing configuration');
 assert.match(missingConfig.body,/budget_service_unavailable/);
 f.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run(run.run_id,'fixture-worker',1,String(Date.now()+60000),'now');
 identity.execution_lease={owner:'fixture-worker',generation:1};
 const request={attempt_id:'model-controlled-1',provider:'fixture',model:'bounded',max_tokens:20};
 const invoke=(action,payload={},auth)=>f.internal('model-budget',{...identity,action,...payload},auth);
 assert.equal((await invoke('reserve',{request},'')).statusCode,401);
 assert.equal((await invoke('reserve',{request,owner_id:'bob'})).statusCode,403);
 assert.equal((await invoke('reserve',{request:{...request,rates:{output:0}}})).statusCode,422);
 const reserved=await invoke('reserve',{request});assert.equal(reserved.statusCode,200,reserved.body);assert.equal(reserved.json().receipt.state,'reserved');
 assert.equal((await invoke('reserve',{request})).body,reserved.body);
 const dispatch=await invoke('dispatch',{attempt_id:request.attempt_id});assert.equal(dispatch.statusCode,200,dispatch.body);
 assert.equal((await invoke('dispatch',{attempt_id:request.attempt_id})).statusCode,409);
 const b=await f.agent('Other owner','bob'),other=await f.json('POST',`/v1/conversations/${b.conversation_id}/messages`,{client_message_id:randomUUID(),content:[{type:'text',text:'Other user'}]},202,'bob');
 const forged=await f.internal('model-budget',{run_id:run.run_id,session_ref:f.bind('bob',b.conversation_id),action:'settle',attempt_id:request.attempt_id,usage:{inputTokens:0,outputTokens:0,totalTokens:0}});assert.equal(forged.statusCode,403,forged.body);
 assert.equal((await f.internal('model-budget',{run_id:other.run_id,session_ref:f.bind('bob',b.conversation_id),action:'settle',attempt_id:request.attempt_id,usage:{inputTokens:0,outputTokens:0,totalTokens:0}})).statusCode,409);
 const deletion=f.workbench.deletionPreview('alice',a.agent_id);f.workbench.deleteAgent('alice',a.agent_id,deletion.version);
 assert.equal((await invoke('reserve',{request:{...request,attempt_id:'after-revoke'}})).statusCode,409);
 const settled=await invoke('settle',{attempt_id:request.attempt_id,usage:{inputTokens:20,outputTokens:5,cacheReadTokens:10,cacheWriteTokens:5,totalTokens:40}});
 assert.equal(settled.statusCode,200,settled.body);assert.equal(settled.json().receipt.actual.nano_usd,'115');
 assert.equal(f.modelBudgets.balance('alice',scope.scope_id).held.tokens,'0');
});

test('background task exposes only its bound ledger and immutable native Goal identity',async t=>{
 const f=await fixture(t),a=await f.agent('Task researcher');
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Parent goal',agent_id:a.agent_id,objective:'Research three controlled sources',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}} ,201);
 const o=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202);
 const identity={run_id:o.run_id,session_ref:f.bind('alice',o.conversation_id)};
 const guarded=await f.internal('guard',identity);assert.equal(guarded.statusCode,200,guarded.body);
 assert.equal(guarded.json().context.task_binding.task_id,task.task_id);
 assert.equal(guarded.json().context.task_binding.occurrence_id,o.occurrence_id);
 assert.equal(guarded.json().context.task_binding.objective,task.objective);
 const invoke=(operation,args={},call_id='task-call')=>f.internal('tool',{...identity,operation,arguments:args,call_id});
 const ledger=await invoke('tasks.get');assert.equal(ledger.statusCode,200,ledger.body);assert.equal(ledger.json().task.task_id,task.task_id);
 const write=await invoke('tasks.upsert',{title:'First source',acceptance:'Verified source URL'},'create-subtask');assert.equal(write.statusCode,200,write.body);
 const repeat=await invoke('tasks.upsert',{title:'First source',acceptance:'Verified source URL'},'create-subtask');assert.equal(repeat.body,write.body);
 assert.equal(f.persistentTasks.subtasks('alice',task.task_id).items.length,1);
 const subtask=write.json(),source=[{kind:'receipt',reference:'fixture:observed'}];
 const observations={understanding:{confirmed:true,objective_summary:'First source',acceptance_criteria:['Verified source URL'],source_refs:source},prerequisites:[{key:'public source',status:'met',source_refs:source}],evidence_requirements:[{key:'verified source',evidence_refs:[]}],target:{expected_count:1,observed_count:1,source_refs:source},capabilities:[{name:'web.read',status:'healthy',source_refs:source}],authorization:{status:'authorized',source_refs:source},model_raw_score:0.99};
 const observe=await invoke('tasks.observe',{subtask_id:subtask.subtask_id,observations});assert.equal(observe.statusCode,200,observe.body);
 const assessArgs={subtask_id:subtask.subtask_id,observations,...observe.json()};
 const assess=await invoke('tasks.assess',assessArgs,'assess-subtask');assert.equal(assess.statusCode,200,assess.body);
 assert.equal(assess.json().calibration_version,null);assert.equal(assess.json().model_raw_score,0.99);assert.ok(assess.json().readiness_score<100);
 assert.equal((await invoke('tasks.assess',assessArgs,'assess-subtask')).body,assess.body,'same call receipt cannot append another assessment');
 const reread=await invoke('tasks.get');assert.equal(reread.statusCode,200,reread.body);
 const next=await invoke('tasks.next');assert.equal(next.statusCode,200,next.body);assert.equal(next.json().items[0].next_action,'gather_evidence');
 const assessment=await invoke('tasks.assessment',{subtask_id:subtask.subtask_id});assert.equal(assessment.statusCode,200,assessment.body);assert.equal(assessment.json().display.completion_confirmed,false);
 const badComplete=await invoke('tasks.upsert',{subtask_id:subtask.subtask_id,expected_version:subtask.version,status:'completed'},'bad-complete');assert.equal(badComplete.statusCode,422,badComplete.body);
 const fabricated=await invoke('tasks.upsert',{subtask_id:subtask.subtask_id,expected_version:subtask.version,status:'completed',evidence:[{kind:'tool_receipt',reference:'proof-invented'}]},'fake-proof');assert.equal(fabricated.statusCode,422,fabricated.body);
 const file=await invoke('files.write',{path:'task/result.txt',content:'Controlled source evidence',expected_version:0},'file-proof');assert.equal(file.statusCode,200,file.body);
 assert.equal(file.json().execution_receipt.kind,'tool_receipt');
 const completed=await invoke('tasks.upsert',{subtask_id:subtask.subtask_id,expected_version:subtask.version,status:'completed',evidence:[file.json().execution_receipt]},'verified-complete');assert.equal(completed.statusCode,200,completed.body);
 assert.equal((await invoke('tasks.assessment',{subtask_id:subtask.subtask_id})).json().display.completion_confirmed,true);
 const forged=await invoke('tasks.get',{task_id:'task-another'});assert.equal(forged.statusCode,403,forged.body);
 const chat=await f.chat(a),chatIdentity={run_id:chat.run_id,session_ref:f.bind('alice',a.conversation_id)};
 assert.equal((await f.internal('tool',{...chatIdentity,operation:'tasks.get',arguments:{}})).statusCode,403);
 const before=await f.internal('goal-binding',{...identity,action:'get'});assert.equal(before.statusCode,200,before.body);assert.equal(before.json().binding,null);
 const save=await f.internal('goal-binding',{...identity,action:'save',goal_id:'goal-native-fixture',goal_revision:1});assert.equal(save.statusCode,200,save.body);
 const retry=await f.internal('goal-binding',{...identity,action:'save',goal_id:'goal-native-fixture',goal_revision:2});assert.equal(retry.statusCode,200,retry.body);
 assert.equal(retry.json().binding.goal_revision,2);
 assert.equal((await f.internal('goal-binding',{...identity,action:'save',goal_id:'goal-forged-replacement',goal_revision:1})).statusCode,409);
 assert.equal((await f.internal('goal-binding',{...identity,action:'save',goal_id:'goal-native-fixture',goal_revision:1})).statusCode,409);
 assert.equal((await f.internal('goal-binding',{...identity,action:'get'},'')).statusCode,401);
 const current=f.persistentTasks.get('alice',task.task_id);f.persistentTasks.pause('alice',task.task_id,current.version);
 assert.equal((await invoke('tasks.get')).statusCode,409);
 assert.equal((await f.internal('goal-binding',{...identity,action:'get'})).statusCode,409);
});

test('an admitted final occurrence can select subtasks after trigger budget exhaustion, but terminal work cannot',async t=>{
 const f=await fixture(t),a=await f.agent('Dependency reader');
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Single delivery',agent_id:a.agent_id,objective:'Read then report',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'},budget:{max_runs:1}},201);
 const o=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),identity={run_id:o.run_id,session_ref:f.bind('alice',o.conversation_id)};
 assert.equal(f.persistentTasks.get('alice',task.task_id).status,'budget_exhausted');
 const invoke=(operation,args={},call_id=randomUUID())=>f.internal('tool',{...identity,operation,arguments:args,call_id});
 const sub=(await invoke('tasks.upsert',{title:'Read',acceptance:'Stored report'})).json();
 const source=[{kind:'observation',reference:'fixture:source'}],observations={understanding:{confirmed:true,objective_summary:'Read',acceptance_criteria:['Stored report'],source_refs:source},prerequisites:[{key:'source',status:'met',source_refs:source}],evidence_requirements:[{key:'report',evidence_refs:[]}],target:{expected_count:1,observed_count:1,source_refs:source},capabilities:[{name:'files.write',status:'healthy',source_refs:source}],authorization:{status:'authorized',source_refs:source}};
 const observe=await invoke('tasks.observe',{subtask_id:sub.subtask_id,observations});assert.equal(observe.statusCode,200,observe.body);
 assert.equal((await invoke('tasks.assess',{subtask_id:sub.subtask_id,observations,...observe.json()})).statusCode,200);
 const next=await invoke('tasks.next');assert.equal(next.statusCode,200,next.body);assert.equal(next.json().items[0]?.subtask_id,sub.subtask_id);
 assert.equal(f.persistentTasks.readiness('alice',task.task_id).next.items[0]?.subtask_id,sub.subtask_id);
 f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(o.run_id);
 assert.equal(f.persistentTasks.readiness('alice',task.task_id).next.items.length,0);
});

test('a completed label with fabricated or stale dependency proof cannot admit running work',async t=>{
 const f=await fixture(t),a=await f.agent('Proof gate');
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Proof chain',agent_id:a.agent_id,objective:'Read then publish',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}},201);
 const o=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),identity={run_id:o.run_id,session_ref:f.bind('alice',o.conversation_id)};
 const invoke=(operation,args={},call_id=randomUUID())=>f.internal('tool',{...identity,operation,arguments:args,call_id});
 const dependency=f.persistentTasks.upsertSubtask('alice',task.task_id,{title:'Owner assertion',status:'completed',evidence:[{kind:'artifact',reference:'unverified'}]});
 const child=(await invoke('tasks.upsert',{title:'Publish',dependencies:[dependency.subtask_id]})).json();
 const start=await invoke('tasks.upsert',{subtask_id:child.subtask_id,expected_version:child.version,status:'running'});
 assert.equal(start.statusCode,409,start.body);assert.match(start.body,/DEPENDENCY_EVIDENCE_UNVERIFIED/);
 assert.equal(f.persistentTasks.subtasks('alice',task.task_id).items.find(s=>s.subtask_id===child.subtask_id).version,child.version);
 const written=await invoke('files.write',{path:'dependency/report.txt',content:'Verified source',expected_version:0});assert.equal(written.statusCode,200,written.body);
 const updated=await invoke('tasks.upsert',{subtask_id:dependency.subtask_id,expected_version:dependency.version,evidence:[written.json().execution_receipt]});assert.equal(updated.statusCode,200,updated.body);
 const started=await invoke('tasks.upsert',{subtask_id:child.subtask_id,expected_version:child.version,status:'running'});assert.equal(started.statusCode,200,started.body);
});

test('dependency execution requires proof from the current occurrence while retaining historical results',async t=>{
 const f=await fixture(t),a=await f.agent('Repeat reader');
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Repeat report',agent_id:a.agent_id,objective:'Read then publish',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}},201);
 const first=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),firstIdentity={run_id:first.run_id,session_ref:f.bind('alice',first.conversation_id)};
 const tool=(identity,operation,args={})=>f.internal('tool',{...identity,operation,arguments:args,call_id:randomUUID()});
 const dependency=(await tool(firstIdentity,'tasks.upsert',{title:'Read'})).json();
 const write=await tool(firstIdentity,'files.write',{path:'repeat/source.txt',content:'First source',expected_version:0});assert.equal(write.statusCode,200,write.body);
 const complete=await tool(firstIdentity,'tasks.upsert',{subtask_id:dependency.subtask_id,expected_version:dependency.version,status:'completed',evidence:[write.json().execution_receipt]});assert.equal(complete.statusCode,200,complete.body);
 f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first.run_id);
 const second=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),secondIdentity={run_id:second.run_id,session_ref:f.bind('alice',second.conversation_id)};
 const child=(await tool(secondIdentity,'tasks.upsert',{title:'Current report',dependencies:[dependency.subtask_id]})).json();
 const refused=await tool(secondIdentity,'tasks.upsert',{subtask_id:child.subtask_id,expected_version:child.version,status:'running'});assert.equal(refused.statusCode,409,refused.body);
 assert.match(refused.body,/DEPENDENCY_NOT_COMPLETED/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_execution_receipts').get().n,1);
 const reset=f.persistentTasks.subtasks('alice',task.task_id).items.find(item=>item.subtask_id===dependency.subtask_id);assert.equal(reset.status,'pending');assert.deepEqual(reset.evidence,[]);
 const historical=f.persistentTasks.subtasks('alice',task.task_id,first.occurrence_id).items.find(item=>item.subtask_id===dependency.subtask_id);assert.deepEqual(historical.evidence,[write.json().execution_receipt]);assert.equal(historical.status,'completed');
 const oldLabel=f.persistentTasks.upsertSubtask('alice',task.task_id,{subtask_id:dependency.subtask_id,expected_version:reset.version,status:'completed',evidence:[write.json().execution_receipt]});
 const oldDisplay=await tool(secondIdentity,'tasks.assessment',{subtask_id:dependency.subtask_id});assert.equal(oldDisplay.statusCode,200,oldDisplay.body);assert.equal(oldDisplay.json().display.completion_confirmed,false,'historical proof cannot confirm current occurrence completion');
 const staleStart=await tool(secondIdentity,'tasks.upsert',{subtask_id:child.subtask_id,expected_version:child.version,status:'running'});assert.equal(staleStart.statusCode,409,staleStart.body);assert.match(staleStart.body,/DEPENDENCY_EVIDENCE_UNVERIFIED/);
 const fresh=await tool(secondIdentity,'files.read',{path:'repeat/source.txt'});assert.equal(fresh.statusCode,200,fresh.body);
 const reverified=await tool(secondIdentity,'tasks.upsert',{subtask_id:dependency.subtask_id,expected_version:oldLabel.version,evidence:[fresh.json().execution_receipt]});assert.equal(reverified.statusCode,200,reverified.body);
 const admitted=await tool(secondIdentity,'tasks.upsert',{subtask_id:child.subtask_id,expected_version:child.version,status:'running'});assert.equal(admitted.statusCode,200,admitted.body);
});

test('occurrence history is owner scoped and the active model cannot reuse historical steps or completion proof',async t=>{
 const f=await fixture(t),a=await f.agent('Repeated workflow');
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Daily report',agent_id:a.agent_id,objective:'Review a source every time',trigger:{kind:'interval',interval_seconds:60}},201);
 const first=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),firstIdentity={run_id:first.run_id,session_ref:f.bind('alice',first.conversation_id)};
 const invoke=(identity,operation,args={},call_id=randomUUID())=>f.internal('tool',{...identity,operation,arguments:args,call_id});
 const sub=(await invoke(firstIdentity,'tasks.upsert',{title:'Read source'})).json(),write=await invoke(firstIdentity,'files.write',{path:'history/source.txt',content:'Current source',expected_version:0});assert.equal(write.statusCode,200,write.body);
 const completed=(await invoke(firstIdentity,'tasks.upsert',{subtask_id:sub.subtask_id,expected_version:sub.version,status:'completed',evidence:[write.json().execution_receipt]})).json();
 f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first.run_id);
 const second=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),identity={run_id:second.run_id,session_ref:f.bind('alice',second.conversation_id)};
 const before=f.countRuns(),history=await f.http('GET',`/v1/persistent-tasks/${task.task_id}/subtasks?occurrence_id=${first.occurrence_id}`);
 assert.equal(history.statusCode,200,history.body);assert.deepEqual(history.json().items,[completed]);assert.equal(f.countRuns(),before);
 const current=(await invoke(identity,'tasks.subtasks')).json().items[0];assert.equal(current.status,'pending');assert.deepEqual(current.evidence,[]);
 const remembered=await invoke(identity,'tasks.subtasks',{occurrence_id:first.occurrence_id});assert.equal(remembered.statusCode,200,remembered.body);assert.deepEqual(remembered.json().items,[completed]);
 assert.equal((await invoke(identity,'tasks.upsert',{subtask_id:sub.subtask_id,expected_version:completed.version,status:'running'})).statusCode,409);
 assert.equal((await invoke(identity,'tasks.upsert',{subtask_id:sub.subtask_id,expected_version:current.version,status:'completed',evidence:[write.json().execution_receipt]})).statusCode,422);
 assert.equal((await f.http('GET',`/v1/persistent-tasks/${task.task_id}/subtasks?occurrence_id=${first.occurrence_id}`,undefined,'bob')).statusCode,404);
 const other=await f.json('POST','/v1/persistent-tasks',{title:'Another workflow',agent_id:a.agent_id,objective:'Separate report',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}},201);
 const foreign=await f.json('POST',`/v1/persistent-tasks/${other.task_id}/run-now`,{},202);
 assert.equal((await f.http('GET',`/v1/persistent-tasks/${task.task_id}/subtasks?occurrence_id=${foreign.occurrence_id}`)).statusCode,404);
 assert.equal((await invoke(identity,'tasks.subtasks',{occurrence_id:foreign.occurrence_id})).statusCode,404);
 assert.equal((await f.http('GET',`/v1/persistent-tasks/${task.task_id}/subtasks?session_id=private-session`)).statusCode,422);
});

test('changing a dependency after admission stops real effects while ledger repair remains available',async t=>{
 const f=await fixture(t),a=await f.json('POST','/v1/agents',{name:'Active dependency guard',instructions:'Read and publish after dependency review',workspace_id:'main',allowed_tools:['universe_search']},201);
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Guarded report',agent_id:a.agent_id,objective:'Read then publish',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}},201);
 const o=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),identity={run_id:o.run_id,session_ref:f.bind('alice',o.conversation_id)};
 const invoke=(operation,args={},call_id=randomUUID())=>f.internal('tool',{...identity,operation,arguments:args,call_id});
 const dependency=(await invoke('tasks.upsert',{title:'Read'})).json();
 const proof=(await invoke('files.write',{path:'gate/source.txt',content:'Source',expected_version:0})).json().execution_receipt;
 const completed=(await invoke('tasks.upsert',{subtask_id:dependency.subtask_id,expected_version:dependency.version,status:'completed',evidence:[proof]})).json();
 const child=(await invoke('tasks.upsert',{title:'Publish',dependencies:[dependency.subtask_id],status:'running'})).json();
 const changed=await invoke('tasks.upsert',{subtask_id:dependency.subtask_id,expected_version:completed.version,status:'pending'});assert.equal(changed.statusCode,200,changed.body);
 const guarded=await f.internal('guard',{...identity,tool_name:'universe_search'});assert.equal(guarded.statusCode,409,guarded.body);
 const effect=await invoke('files.write',{path:'gate/output.txt',content:'Must not be published',expected_version:0},'blocked-effect');assert.equal(effect.statusCode,409,effect.body);
 assert.equal(f.workbench.listFiles('alice',a.workspace_id,a.project_id,o.run_id).items.some(file=>file.path==='gate/output.txt'),false);
 const read=await invoke('web.read',{url:'https://127.0.0.1:1'},'blocked-read');assert.equal(read.statusCode,409,read.body);
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_task_execution_receipts WHERE call_id='blocked-effect'").get().n,0);
 const ledger=await invoke('tasks.get');assert.equal(ledger.statusCode,200,ledger.body);
 const blocked=await invoke('tasks.upsert',{subtask_id:child.subtask_id,expected_version:child.version,status:'blocked'});assert.equal(blocked.statusCode,200,blocked.body);
 const planning=await f.internal('guard',{...identity,tool_name:'universe_search'});assert.equal(planning.statusCode,200,planning.body);
 const reviewed=await invoke('files.read',{path:'gate/source.txt'});assert.equal(reviewed.statusCode,200,reviewed.body);
 const fixed=await invoke('tasks.upsert',{subtask_id:dependency.subtask_id,expected_version:changed.json().version,status:'completed',evidence:[reviewed.json().execution_receipt]});assert.equal(fixed.statusCode,200,fixed.body);
 const restarted=await invoke('tasks.upsert',{subtask_id:child.subtask_id,expected_version:blocked.json().version,status:'running'});assert.equal(restarted.statusCode,200,restarted.body);
 const delivered=await invoke('files.write',{path:'gate/output.txt',content:'Reviewed report',expected_version:0},'blocked-effect');assert.equal(delivered.statusCode,200,delivered.body);
 // Owner bookkeeping may change a label without replacing the immutable receipt.
 // A running child's tool boundary must catch that change too.
 const corrupted=f.persistentTasks.upsertSubtask('alice',task.task_id,{subtask_id:dependency.subtask_id,expected_version:fixed.json().version,evidence:[{...reviewed.json().execution_receipt,hash:'f'.repeat(64)}]});
 assert.equal(corrupted.status,'completed');
 assert.equal((await f.internal('guard',{...identity,tool_name:'universe_search'})).statusCode,409);
 assert.equal((await invoke('files.read',{path:'gate/source.txt'},'invalid-proof-read')).statusCode,409);
 assert.equal((await invoke('files.write',{path:'gate/output.txt',content:'Reviewed report',expected_version:0},'blocked-effect')).body,delivered.body,'receipt replay must not perform a new effect');
});

test('dependency changes propagate through the full chain to admission, candidates and actual effects',async t=>{
 const f=await fixture(t),a=await f.json('POST','/v1/agents',{name:'Chained task',instructions:'Review sources then write then publish',workspace_id:'main',allowed_tools:['universe_search']},201);
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Three stages',agent_id:a.agent_id,objective:'Read, write, publish',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}},201);
 const o=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{},202),identity={run_id:o.run_id,session_ref:f.bind('alice',o.conversation_id)};
 const invoke=(operation,args={})=>f.internal('tool',{...identity,operation,arguments:args,call_id:randomUUID()});
 const proof=(await invoke('files.write',{path:'chain/source.txt',content:'Reviewed source',expected_version:0})).json().execution_receipt;
 const source=(await invoke('tasks.upsert',{title:'Read',status:'completed',evidence:[proof]})).json();
 const report=(await invoke('tasks.upsert',{title:'Report',dependencies:[source.subtask_id],status:'completed',evidence:[proof]})).json();
 const running=(await invoke('tasks.upsert',{title:'Publish',dependencies:[report.subtask_id],status:'running'})).json();
 const candidate=(await invoke('tasks.upsert',{title:'Archive',dependencies:[report.subtask_id]})).json();
 const refs=[{kind:'observation',reference:'fixture:chain'}],observations={understanding:{confirmed:true,objective_summary:'Archive',acceptance_criteria:['Stored output'],source_refs:refs},prerequisites:[{key:'report',status:'met',source_refs:refs}],evidence_requirements:[{key:'report',evidence_refs:[proof]}],target:{expected_count:1,observed_count:1,source_refs:refs},capabilities:[{name:'files.write',status:'healthy',source_refs:refs}],authorization:{status:'authorized',source_refs:refs}};
 const observed=(await invoke('tasks.observe',{subtask_id:candidate.subtask_id,observations})).json();
 assert.equal((await invoke('tasks.assess',{subtask_id:candidate.subtask_id,observations,...observed})).statusCode,200);
 assert.equal((await invoke('tasks.upsert',{subtask_id:source.subtask_id,expected_version:source.version,status:'pending'})).statusCode,200);
 assert.equal((await f.internal('guard',{...identity,tool_name:'universe_search'})).statusCode,409);
 const next=await invoke('tasks.next');assert.equal(next.statusCode,200,next.body);assert.equal(next.json().items.length,0);
 assert.ok(next.json().blocked.find(item=>item.subtask_id===candidate.subtask_id).reasons.includes(`dependency_not_completed:${source.subtask_id}`));
 const start=await invoke('tasks.upsert',{subtask_id:candidate.subtask_id,expected_version:candidate.version,status:'running'});assert.equal(start.statusCode,409,start.body);
 const repair=await invoke('tasks.upsert',{subtask_id:running.subtask_id,expected_version:running.version,status:'blocked'});assert.equal(repair.statusCode,200,repair.body);
 assert.equal((await f.internal('guard',{...identity,tool_name:'universe_search'})).statusCode,200,'planning can recover after suspending the dependent step');
});

test('completion proof rejects fabricated, foreign-task and changed-hash receipts and retries atomically',async t=>{
 const f=await fixture(t),a=await f.agent('Evidence researcher');
 const createTask=title=>f.json('POST','/v1/persistent-tasks',{title,agent_id:a.agent_id,objective:'Save a controlled source',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}},201);
 const first=await createTask('Source proof'),second=await createTask('Other goal');
 const run=await f.json('POST',`/v1/persistent-tasks/${first.task_id}/run-now`,{},202);
 const identity={run_id:run.run_id,session_ref:f.bind('alice',run.conversation_id)};
 const invoke=(operation,args={},call_id)=>f.internal('tool',{...identity,operation,arguments:args,...(call_id?{call_id}:{})});
 const written=await invoke('files.write',{path:'proof.txt',content:'A controlled result',expected_version:0},'write-source');assert.equal(written.statusCode,200,written.body);
 const proof=written.json().execution_receipt;
 const output=f.db.prepare('SELECT * FROM wb_task_file_execution_receipts WHERE receipt_id=?').get(proof.reference);
 assert.equal(output.run_id,run.run_id);assert.equal(output.owner_id,'alice');assert.equal(output.path,'proof.txt');
 assert.equal(output.version,1);assert.equal(output.sha256,written.json().sha256);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_file_write_runs').get().n,1);
 assert.throws(()=>f.db.prepare('UPDATE wb_file_write_runs SET sha256=? WHERE run_id=?').run('f'.repeat(64),run.run_id),/file_write_run_immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_task_file_execution_receipts WHERE receipt_id=?').run(proof.reference),/file_execution_receipt_immutable/);
 const receipts=new TaskExecutionEvidence(f.db);
 assert.throws(()=>withImmediateTransaction(f.db,()=>receipts.record(run.run_id,'forged-version','files.write',{...written.json(),version:99})),/file_execution_output_unverified/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>receipts.record(run.run_id,'forged-hash','files.write',{...written.json(),sha256:'f'.repeat(64)})),/file_execution_output_unverified/);
 assert.equal((await invoke('files.write',{path:'proof.txt',content:'A controlled result',expected_version:0},'write-source')).body,written.body);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_execution_receipts').get().n,1);
 const read=await invoke('files.read',{path:'proof.txt'},'read-source');assert.equal(read.statusCode,200,read.body);
 assert.equal((await invoke('files.read',{path:'proof.txt'},'read-source')).body,read.body);
 assert.equal((await invoke('files.read',{path:'different.txt'},'read-source')).statusCode,409);
 assert.equal((await invoke('files.read',{path:'proof.txt'})).statusCode,422);
 const subtask=f.persistentTasks.upsertSubtask('alice',first.task_id,{title:'Verified output',acceptance:'Inspect source'});
 const altered=await invoke('tasks.upsert',{subtask_id:subtask.subtask_id,expected_version:subtask.version,status:'completed',evidence:[{...proof,hash:'f'.repeat(64)}]},'altered-proof');assert.equal(altered.statusCode,422,altered.body);
 const mixed=await invoke('tasks.upsert',{subtask_id:subtask.subtask_id,expected_version:subtask.version,status:'completed',evidence:[proof,{kind:'tool_receipt',reference:'invented-extra'}]},'mixed-proof');assert.equal(mixed.statusCode,422,mixed.body);
 const otherRun=await f.json('POST',`/v1/persistent-tasks/${second.task_id}/run-now`,{},202);
 assert.throws(()=>withImmediateTransaction(f.db,()=>receipts.record(otherRun.run_id,'stolen-output','files.write',written.json())),/file_execution_output_unverified/);
 const other=await f.internal('tool',{run_id:otherRun.run_id,session_ref:f.bind('alice',otherRun.conversation_id),operation:'tasks.upsert',call_id:'foreign-proof',arguments:{title:'Pretended output',acceptance:'Other task',status:'completed',evidence:[proof]}});assert.equal(other.statusCode,422,other.body);
 const manual=f.persistentTasks.upsertSubtask('alice',first.task_id,{title:'Owner assertion',acceptance:'Unverified attachment',status:'completed',evidence:[{kind:'artifact',reference:'invented-artifact'}]});
 const asserted=await invoke('tasks.assessment',{subtask_id:manual.subtask_id});assert.equal(asserted.statusCode,200,asserted.body);assert.equal(asserted.json().display.completion_confirmed,false);
 const mixedOwner=f.persistentTasks.upsertSubtask('alice',first.task_id,{title:'Mixed owner proof',status:'completed',evidence:[proof,{kind:'tool_receipt',reference:'fabricated-owner-proof'}]});
 const mixedView=await invoke('tasks.assessment',{subtask_id:mixedOwner.subtask_id});assert.equal(mixedView.statusCode,200,mixedView.body);assert.equal(mixedView.json().display.completion_confirmed,false,'an owner label with one valid and one forged receipt is not verified completion');
 const implicit=await invoke('tasks.upsert',{subtask_id:manual.subtask_id,expected_version:manual.version,evidence:[{kind:'tool_receipt',reference:'invented-implicit'}]},'implicit-completion');assert.equal(implicit.statusCode,422,implicit.body);
 f.db.exec("CREATE TRIGGER reject_proof_call BEFORE INSERT ON wb_tool_receipts WHEN NEW.call_id='rollback-proof' BEGIN SELECT RAISE(ABORT,'controlled receipt failure'); END;");
 const before=f.db.prepare('SELECT count(*) n FROM wb_task_execution_receipts').get().n;
 const failed=await invoke('files.write',{path:'proof.txt',content:'Must roll back',expected_version:1},'rollback-proof');assert.equal(failed.statusCode,500,failed.body);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_file_write_runs').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_file_execution_receipts').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_execution_receipts').get().n,before);
 assert.equal(f.workbench.readFile('alice','main',a.project_id,'proof.txt',run.run_id).content,'A controlled result');
 f.db.exec('DROP TRIGGER reject_proof_call');
 assert.equal((await invoke('tasks.get')).json().execution_receipt,undefined,'ledger bookkeeping is not execution evidence');
});

test('calendar preview is authenticated, matches created task and leaves no task or run side effects',async t=>{
 const f=await fixture(t);
 const caps=await f.json('GET','/v1/capabilities');
 assert.ok(caps.workbench.task_triggers.includes('daily'));
 assert.ok(caps.workbench.task_triggers.includes('weekly'));
 const trigger={kind:'daily',time:'09:30',timezone:'Asia/Hong_Kong'};
 const beforeTasks=f.db.prepare('SELECT count(*) n FROM wb_persistent_tasks').get().n;
 const beforeRequests=f.db.prepare('SELECT count(*) n FROM ga_idempotency').get().n;
 const preview=await f.json('POST','/v1/persistent-tasks/preview',{trigger});
 assert.equal(preview.timezone,'Asia/Hong_Kong');
 assert.match(preview.next_due_at,/T01:30:00\.000Z$/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_persistent_tasks').get().n,beforeTasks);
 assert.equal(f.countRuns(),0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_idempotency').get().n,beforeRequests);
 const unauthorized=await f.app.inject({method:'POST',url:'/v1/persistent-tasks/preview',payload:{trigger}});
 assert.equal(unauthorized.statusCode,401);
 const noCsrf=await f.app.inject({method:'POST',url:'/v1/persistent-tasks/preview',headers:{'x-user-id':'alice',origin},payload:{trigger}});
 assert.equal(noCsrf.statusCode,403);
 assert.equal((await f.http('POST','/v1/persistent-tasks/preview',{trigger,owner_id:'bob'})).statusCode,400);
 assert.equal((await f.http('POST','/v1/persistent-tasks/preview',{trigger:{...trigger,timezone:'invalid/zone'}})).statusCode,422);
 const a=await f.agent('Calendar watcher');
 const created=await f.json('POST','/v1/persistent-tasks',{title:'Morning research',agent_id:a.agent_id,objective:'Summarize sources',trigger},201);
 assert.equal(created.next_due_at,preview.next_due_at);
 assert.equal(created.trigger.timezone,trigger.timezone);
 assert.equal((await f.http('GET',`/v1/persistent-tasks/${created.task_id}`,undefined,'bob')).statusCode,404);
});

test('public task readiness is read-only owner scoped and never exposes internal Goal or session identity',async t=>{
 const f=await fixture(t),a=await f.agent('Readiness viewer');
 const task=await f.json('POST','/v1/persistent-tasks',{title:'Readiness goal',agent_id:a.agent_id,objective:'Inspect controlled sources',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}},201);
 const sub=f.persistentTasks.upsertSubtask('alice',task.task_id,{title:'Gather source',acceptance:'Source receipt'});
 const beforeRuns=f.countRuns(),beforeAssessments=f.db.prepare('SELECT count(*) n FROM wb_task_assessments').get().n;
 const result=await f.http('GET',`/v1/persistent-tasks/${task.task_id}/readiness`);assert.equal(result.statusCode,200,result.body);
 assert.equal(result.json().parent.display.label,'执行准备度，供参考');
 assert.equal(result.json().subtasks[0].subtask_id,sub.subtask_id);assert.equal(result.json().subtasks[0].display.readiness_score,null);
 assert.ok(result.json().subtasks[0].stale_reasons.includes('assessment_missing'));
 assert.equal(result.json().next.blocked[0].subtask_id,sub.subtask_id);
 for(const key of ['owner_id','session_id','goal_id','session_ref','directory','instructions'])assert.equal(result.body.includes(`"${key}"`),false,key);
 assert.equal(f.countRuns(),beforeRuns);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_assessments').get().n,beforeAssessments);
 assert.equal((await f.http('GET',`/v1/persistent-tasks/${task.task_id}/readiness`,undefined,'bob')).statusCode,404);
 assert.equal((await f.http('GET',`/v1/persistent-tasks/${task.task_id}/readiness?owner_id=bob`)).statusCode,422);
 assert.equal((await f.app.inject({method:'GET',url:`/v1/persistent-tasks/${task.task_id}/readiness`})).statusCode,401);
});

test('memory lifecycle sources, expiry, scoped export and model proposals stay bound to owner and role',async t=>{
 const f=await fixture(t),a=await f.agent('Memory A'),b=await f.agent('Memory B');
 const provenance=[{kind:'web',reference:'https://example.com/controlled-source'}];
 const note=await f.json('POST','/v1/workspaces/main/memory',{scope:'private',agent_id:a.agent_id,content:'A sourced fact',verified:true,provenance,source_revision:'fixture-v1',expires_at:'2099-10-02T09:00:00+08:00'},201);
 assert.deepEqual(note.provenance,provenance);assert.equal(note.expires_at,'2099-10-02T01:00:00.000Z');assert.ok(note.verified_at);
 const expired=await f.json('POST','/v1/workspaces/main/memory',{scope:'private',agent_id:a.agent_id,content:'A expired fact',expires_at:'2000-01-01T00:00:00Z'},201);
 await f.json('POST','/v1/workspaces/main/memory',{scope:'private',agent_id:b.agent_id,content:'B isolated fact',provenance},201);
 const ordinary=await f.json('GET',`/v1/workspaces/main/memory?scope=private&agent_id=${a.agent_id}`);
 assert.deepEqual(ordinary.items.map(x=>x.content),['A sourced fact']);
 const managed=await f.json('GET',`/v1/workspaces/main/memory?scope=private&agent_id=${a.agent_id}&include_expired=true`);
 assert.ok(managed.items.some(x=>x.memory_id===expired.memory_id&&x.expired));
 const exported=await f.json('GET',`/v1/workspaces/main/memory/export?scope=private&agent_id=${a.agent_id}&include_expired=true`);
 assert.equal(exported.schema_version,1);assert.equal(exported.items.length,2);assert.doesNotMatch(JSON.stringify(exported),/B isolated fact|owner_id|session_id|server_path/);
 assert.equal((await f.http('GET',`/v1/workspaces/main/memory/export?scope=private&agent_id=${a.agent_id}`,undefined,'bob')).statusCode,404);
 const receipt=await f.chat(a),identity={run_id:receipt.run_id,session_ref:f.bind('alice',a.conversation_id)};
 const save=await f.internal('tool',{...identity,operation:'memory.save',arguments:{scope:'private',content:'Model-proposed fact',provenance,source_revision:'proposed-v1'},call_id:'memory-proposal-1'});
 assert.equal(save.statusCode,200,save.body);assert.equal(save.json().verified,false);assert.equal(save.json().verified_at,null);
 const rewrite=await f.internal('tool',{...identity,operation:'memory.save',arguments:{scope:'private',memory_id:note.memory_id,expected_version:note.version,content:'Unverified overwrite'},call_id:'memory-overwrite-1'});
 assert.equal(rewrite.statusCode,409,rewrite.body);assert.equal(rewrite.json().error.code,'MEMORY_VERIFICATION_REQUIRED');
 const replace=await f.internal('tool',{...identity,operation:'memory.save',arguments:{scope:'private',supersedes:note.memory_id,content:'Unverified replacement'},call_id:'memory-supersede-1'});
 assert.equal(replace.statusCode,409,replace.body);assert.equal(replace.json().error.code,'MEMORY_VERIFICATION_REQUIRED');
 assert.equal((await f.internal('tool',{...identity,operation:'memory.save',arguments:{scope:'private',content:'Cannot self-verify',verified:true},call_id:'memory-forge-1'})).statusCode,403);
 const context=await f.internal('guard',identity);assert.equal(context.statusCode,200,context.body);assert.doesNotMatch(context.body,/A expired fact|B isolated fact/);
 await f.json('DELETE',`/v1/workspaces/main/memory/${note.memory_id}`,{expected_version:note.version});
 const after=await f.internal('guard',identity);assert.equal(after.statusCode,200,after.body);assert.doesNotMatch(after.body,/A sourced fact/);
});

test('integrated role routes enforce owner, version, CSRF and immutable run instructions',async t=>{
 const f=await fixture(t),a=await f.agent('Researcher');
 assert.equal((await f.json('GET','/v1/agents')).items.length,1);
 assert.equal((await f.http('GET',`/v1/agents/${a.agent_id}`,undefined,'bob')).statusCode,404);
 assert.equal((await f.json('GET','/v1/agents',undefined,200,'bob')).items.length,0);
 const unsafe=await f.app.inject({method:'POST',url:'/v1/agents',headers:{'x-user-id':'alice',origin,'x-csrf-token':'invalid','idempotency-key':randomUUID()},payload:{name:'Bad'}});assert.equal(unsafe.statusCode,403);
 const receipt=await f.chat(a),updated=await f.json('PATCH',`/v1/agents/${a.agent_id}`,{name:'Researcher 2',instructions:'New responsibility',expected_version:a.version});
 assert.equal(updated.version,a.version+1);assert.equal(updated.name,'Researcher 2');
 assert.equal(f.workbench.contextForRun(receipt.run_id).instructions,'Researcher responsibility');
 assert.equal(f.workbench.contextForRun(receipt.run_id).kind,'chat');
 assert.equal((await f.http('PATCH',`/v1/agents/${a.agent_id}`,{name:'stale',expected_version:a.version})).statusCode,409);
 assert.equal((await f.http('PATCH',`/v1/agents/${a.agent_id}`,{name:'intrusion',expected_version:updated.version},'bob')).statusCode,404);
 const browserSnapshot=await f.http('GET',`/v1/conversations/${a.conversation_id}/snapshot`);assert.equal(browserSnapshot.statusCode,200);assert.doesNotMatch(browserSnapshot.body,/session_id|harness_session_ref|capability_epoch|allowed_tools/);
});

test('integrated team CRUD rejects foreign members and protects membership versions',async t=>{
 const f=await fixture(t),a=await f.agent('A'),b=await f.agent('B'),foreign=await f.agent('Foreign','bob');
 const team=await f.json('POST','/v1/teams',{name:'Team',workspace_id:'main',member_ids:[a.agent_id,b.agent_id]},201);assert.deepEqual(team.member_ids,[a.agent_id,b.agent_id]);
 assert.equal((await f.http('GET',`/v1/teams/${team.team_id}`,undefined,'bob')).statusCode,404);
 assert.equal((await f.http('POST','/v1/teams',{name:'Foreign',member_ids:[a.agent_id,foreign.agent_id]})).statusCode,404);
 const updated=await f.json('PATCH',`/v1/teams/${team.team_id}`,{name:'Focused',member_ids:[b.agent_id],expected_version:team.version});assert.deepEqual(updated.member_ids,[b.agent_id]);
 assert.equal((await f.http('PATCH',`/v1/teams/${team.team_id}`,{member_ids:[a.agent_id],expected_version:team.version})).statusCode,409);
 assert.equal((await f.json('GET','/v1/workspaces/main')).teams[0].team_id,team.team_id);
 await f.json('DELETE',`/v1/teams/${team.team_id}`,{expected_version:updated.version});assert.equal((await f.json('GET','/v1/teams')).items.length,0);
});

test('integrated memory routes isolate private instances, shared projects, owners and correction versions',async t=>{
 const f=await fixture(t),a=await f.agent('A'),b=await f.agent('B');
 const privateNote=await f.json('POST','/v1/workspaces/main/memory',{scope:'private',agent_id:a.agent_id,content:'A secret'},201);
 const shared=await f.json('POST','/v1/workspaces/main/memory',{scope:'project',project_id:a.project_id,content:'Shared evidence',verified:true},201);
 const otherProject=await f.json('POST','/v1/projects',{title:'Other project'},201);await f.json('POST','/v1/workspaces/main/memory',{scope:'project',project_id:otherProject.project_id,content:'Other project evidence'},201);
 assert.deepEqual((await f.json('GET',`/v1/workspaces/main/memory?agent_id=${b.agent_id}`)).items.map(item=>item.content),['Shared evidence']);
 assert.equal((await f.json('GET',`/v1/workspaces/main/memory?agent_id=${a.agent_id}`)).items.length,2);
 assert.equal((await f.json('GET','/v1/workspaces/main/memory',undefined,200,'bob')).items.length,0);
 assert.equal((await f.http('GET',`/v1/workspaces/main/memory?agent_id=${a.agent_id}`,undefined,'bob')).statusCode,404);
 const corrected=await f.json('POST','/v1/workspaces/main/memory',{scope:'private',agent_id:a.agent_id,memory_id:privateNote.memory_id,content:'Correction',expected_version:privateNote.version},201);assert.equal(corrected.version,2);
 assert.equal((await f.http('POST','/v1/workspaces/main/memory',{scope:'private',agent_id:a.agent_id,memory_id:privateNote.memory_id,content:'Stale',expected_version:privateNote.version})).statusCode,409);
 await f.json('DELETE',`/v1/workspaces/main/memory/${privateNote.memory_id}`,{expected_version:corrected.version});assert.deepEqual((await f.json('GET',`/v1/workspaces/main/memory?agent_id=${a.agent_id}`)).items.map(item=>item.memory_id),[shared.memory_id]);
});

test('integrated shared files enforce CAS, owner boundaries and path confinement',async t=>{
 const f=await fixture(t),a=await f.agent('A'),input={project_id:a.project_id,path:'notes/evidence.md',content:'Version one',expected_version:0};
 const first=await f.json('PUT','/v1/workspaces/main/files',input);assert.equal(first.version,1);
 const second=await f.json('PUT','/v1/workspaces/main/files',{...input,content:'Version two',expected_version:1});assert.equal(second.version,2);
 assert.equal((await f.http('PUT','/v1/workspaces/main/files',{...input,content:'stale',expected_version:1})).statusCode,409);
 const contentUrl=`/v1/workspaces/main/files/content?project_id=${a.project_id}&path=notes%2Fevidence.md`;assert.equal((await f.json('GET',contentUrl)).content,'Version two');assert.equal((await f.http('GET',contentUrl,undefined,'bob')).statusCode,404);
 for(const path of ['../escaped.md','/escaped.md','E:\\escaped.md']){const response=await f.http('PUT','/v1/workspaces/main/files',{...input,path});assert.equal(response.statusCode,422,response.body);}
 assert.equal(existsSync(join(f.root,'escaped.md')),false);
 const publicFiles=await f.http('GET',`/v1/workspaces/main/files?project_id=${a.project_id}`);assert.equal(publicFiles.statusCode,200);assert.doesNotMatch(publicFiles.body,/server_path|blob_name|E:\\|E:\//);
});

test('integrated persistent task tick binds a real isolated run and respects duplicate trigger and manual request keys',async t=>{
 const f=await fixture(t),a=await f.agent('Watcher');
 const task=await f.json('POST','/v1/persistent-tasks',{title:'One check',agent_id:a.agent_id,objective:'Read shared evidence',trigger:{kind:'once'},budget:{max_runs:3}},201);
 assert.ok(f.persistentTasks,'server exposes the task service used by scheduling');await f.persistentTasks.tick();await f.persistentTasks.tick();
 const occurrences=(await f.json('GET',`/v1/persistent-tasks/${task.task_id}/occurrences`)).items;assert.equal(occurrences.length,1);assert.equal(f.countRuns(),1);
 const occurrence=occurrences[0],context=f.workbench.contextForRun(occurrence.run_id);assert.equal(context.agent_id,a.agent_id);assert.notEqual(occurrence.conversation_id,a.conversation_id);assert.equal((await f.json('GET',`/v1/runs/${occurrence.run_id}`)).status,'queued');
 assert.equal((await f.http('GET',`/v1/persistent-tasks/${task.task_id}/occurrences`,undefined,'bob')).statusCode,404);
 const overlapping=await f.http('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,{client_message_id:'overlap-request'});assert.equal(overlapping.statusCode,409,overlapping.body);assert.equal(overlapping.json().error.code,'TASK_ACTIVE_OCCURRENCE');assert.equal(f.countRuns(),1);
 f.db.exec('BEGIN');f.runs.appendAssistant(occurrence.run_id,'Controlled fixture completion');f.runs.finalizePublication(occurrence.run_id,'succeeded',null);f.db.exec('COMMIT');
 const key=randomUUID(),body={client_message_id:key};
 const manual=await f.http('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,body,'alice',key);assert.equal(manual.statusCode,202,manual.body);
 const replay=await f.http('POST',`/v1/persistent-tasks/${task.task_id}/run-now`,body,'alice',key);assert.equal(replay.statusCode,202,replay.body);assert.deepEqual(replay.json(),manual.json());assert.equal(f.countRuns(),2);
 const manualIdentity={run_id:manual.json().run_id,session_ref:f.bind('alice',manual.json().conversation_id)};assert.equal((await f.internal('guard',manualIdentity)).statusCode,200);
 const latest=await f.json('GET',`/v1/persistent-tasks/${task.task_id}`),paused=await f.json('POST',`/v1/persistent-tasks/${task.task_id}/pause`,{expected_version:latest.version});assert.equal(paused.status,'paused');const revoked=await f.internal('guard',manualIdentity);assert.equal(revoked.statusCode,409,revoked.body);assert.equal(revoked.json().error.code,'TASK_GENERATION_REVOKED');
 await f.json('POST',`/v1/persistent-tasks/${task.task_id}/resume`,{expected_version:paused.version});assert.equal((await f.internal('guard',manualIdentity)).statusCode,409,'resume must not reauthorize the prior generation');
});

test('deleted roles cannot create runs through their old conversation even with duplicate client input',async t=>{
 const f=await fixture(t),a=await f.agent('A'),key=randomUUID(),payload={client_message_id:key,content:[{type:'text',text:'Original request'}]},url=`/v1/conversations/${a.conversation_id}/messages`;
 const original=await f.http('POST',url,payload,'alice',key);assert.equal(original.statusCode,202,original.body);
 const duplicate=await f.http('POST',url,payload,'alice',key);assert.deepEqual(duplicate.json(),original.json());assert.equal(f.countRuns(),1);
 const deleted=await f.json('DELETE',`/v1/agents/${a.agent_id}`,{expected_version:a.version});assert.equal(deleted.status,'deleted');
 const fresh=await f.http('POST',url,{client_message_id:randomUUID(),content:[{type:'text',text:'New forbidden request'}]});assert.equal(fresh.statusCode,409,fresh.body);assert.equal(fresh.json().error.code,'AGENT_CAPABILITY_REVOKED');
 const repeatedClient=await f.http('POST',url,payload);assert.equal(repeatedClient.statusCode,409,repeatedClient.body);assert.equal(repeatedClient.json().error.code,'AGENT_CAPABILITY_REVOKED');assert.equal(f.countRuns(),1);
 assert.equal((await f.json('GET','/v1/agents')).items.length,0);assert.throws(()=>f.workbench.contextForRun(original.json().run_id),/revoked/);
});

test('internal guard requires bearer, run/session binding and the frozen allowed tool set',async t=>{
 const f=await fixture(t),a=await f.agent('A'),receipt=await f.chat(a),session=f.bind('alice',a.conversation_id),identity={run_id:receipt.run_id,session_ref:session};
 assert.equal((await f.internal('guard',identity,'')).statusCode,401);assert.equal((await f.internal('guard',identity,'Bearer incorrect')).statusCode,401);
 const guarded=await f.internal('guard',identity);assert.equal(guarded.statusCode,200,guarded.body);assert.equal(guarded.json().context.agent_id,a.agent_id);assert.equal(guarded.json().context.instructions,'A responsibility');
 assert.equal((await f.internal('guard',{...identity,tool_name:'jot_workspace'})).statusCode,200);
 assert.equal((await f.internal('guard',{...identity,tool_name:'forbidden_native_shell'})).statusCode,403);
 const other=await f.agent('Other'),otherSession=f.bind('alice',other.conversation_id);assert.equal((await f.internal('guard',{...identity,session_ref:otherSession})).statusCode,403);
 const foreign=await f.agent('Foreign','bob'),foreignSession=f.bind('bob',foreign.conversation_id);assert.equal((await f.internal('guard',{...identity,session_ref:foreignSession})).statusCode,403);
 for(const field of ['owner_id','workspace_id','project_id','agent_id']){const forged=await f.internal('guard',{...identity,[field]:'forged'});assert.ok([403,422].includes(forged.statusCode),forged.body);}
 const ordinary=await f.json('POST','/v1/conversations',{workspace_id:'main',model:{provider:'harness',model:'automatic'}},201),ordinaryRun=await f.chat(ordinary),ordinarySession=f.bind('alice',ordinary.conversation_id);assert.equal((await f.internal('guard',{run_id:ordinaryRun.run_id,session_ref:ordinarySession})).statusCode,403);
});

test('internal tools derive private identity, refuse forged scope and deduplicate side effects by call id',async t=>{
 const f=await fixture(t),a=await f.agent('A'),b=await f.agent('B');
 await f.json('POST','/v1/workspaces/main/memory',{scope:'private',agent_id:a.agent_id,content:'A private'},201);await f.json('POST','/v1/workspaces/main/memory',{scope:'private',agent_id:b.agent_id,content:'B private'},201);await f.json('POST','/v1/workspaces/main/memory',{scope:'project',project_id:a.project_id,content:'Shared'},201);
 const receipt=await f.chat(a),identity={run_id:receipt.run_id,session_ref:f.bind('alice',a.conversation_id)},call=(operation,args,callId=randomUUID())=>f.internal('tool',{...identity,operation,arguments:args,call_id:callId});
 const context=await f.internal('guard',identity);assert.equal(context.statusCode,200,context.body);assert.doesNotMatch(context.body,/B private/);
 assert.equal((await f.internal('tool',{...identity,operation:'memory.list',arguments:{},call_id:'no-bearer'},'')).statusCode,401);
 const memory=await call('memory.list',{});assert.equal(memory.statusCode,200,memory.body);assert.deepEqual(memory.json().items.map(item=>item.content).sort(),['A private','Shared']);assert.doesNotMatch(memory.body,/B private/);
 for(const field of ['owner_id','workspace_id','project_id','agent_id','sender_agent_id']){const forged=await call('memory.list',{[field]:field==='agent_id'?b.agent_id:'forged'});assert.ok([403,422].includes(forged.statusCode),`${field}: ${forged.body}`);}
 const callId=randomUUID(),input={scope:'private',content:'Bound note'},first=await call('memory.save',input,callId);assert.equal(first.statusCode,200,first.body);const second=await call('memory.save',input,callId);assert.equal(second.statusCode,200,second.body);assert.deepEqual(second.json(),first.json());
 assert.equal(Number(f.db.prepare("SELECT count(*) n FROM wb_memories WHERE content='Bound note'").get().n),1);
 const conflict=await call('memory.save',{...input,content:'Changed under same call'},callId);assert.equal(conflict.statusCode,409,conflict.body);
 const fileInput={path:'notes/internal.txt',content:'One controlled write',expected_version:0},file=await call('files.write',fileInput,'file-call-123');assert.equal(file.statusCode,200,file.body);assert.equal(file.json().version,1);const fileReplay=await call('files.write',fileInput,'file-call-123');assert.deepEqual(fileReplay.json(),file.json());assert.equal((await call('files.read',{path:fileInput.path})).json().content,fileInput.content);assert.equal((await call('files.list',{})).json().items.length,1);
 assert.equal((await call('files.write',{...fileInput,content:'Different request'},'file-call-123')).statusCode,409);assert.equal((await call('files.write',{...fileInput,path:'../escaped.txt'},'file-escape-123')).statusCode,422);
 const sent=await call('messages.send',{recipient_agent_id:b.agent_id,text:'Review source'},'message-call-123');assert.equal(sent.statusCode,200,sent.body);assert.equal(sent.json().initiator,'agent');assert.equal(sent.json().sender_agent_id,a.agent_id);
 const again=await call('messages.send',{recipient_agent_id:b.agent_id,text:'Review source'},'message-call-123');assert.deepEqual(again.json(),sent.json());assert.equal((await f.json('GET','/v1/workspaces/main/agent-messages')).items.length,1);
 const foreign=await f.agent('Foreign','bob'),crossOwner=await call('messages.send',{recipient_agent_id:foreign.agent_id,text:'Forbidden scope'},'cross-owner-call');assert.equal(crossOwner.statusCode,404,crossOwner.body);assert.equal((await f.json('GET','/v1/workspaces/main/agent-messages')).items.length,1);
 await f.json('DELETE',`/v1/agents/${a.agent_id}`,{expected_version:a.version});const afterDeletion=await call('memory.save',{scope:'private',content:'Must not write'});assert.equal(afterDeletion.statusCode,409,afterDeletion.body);assert.equal(afterDeletion.json().error.code,'AGENT_CAPABILITY_REVOKED');assert.equal(Number(f.db.prepare("SELECT count(*) n FROM wb_memories WHERE content='Must not write'").get().n),0);
 const revokedReplay=await call('memory.save',input,callId);assert.equal(revokedReplay.statusCode,409,revokedReplay.body);assert.equal(revokedReplay.json().error.code,'AGENT_CAPABILITY_REVOKED');
});

test('review regression: a deleted role cannot resume an old failed checkpoint as an unbound run',async t=>{
 const f=await fixture(t),a=await f.agent('Checkpoint role'),receipt=await f.chat(a);
 f.db.prepare("UPDATE ga_runs SET status='failed',checkpoint_id='checkpoint-fixture',reason_code=NULL WHERE id=?").run(receipt.run_id);
 await f.json('DELETE',`/v1/agents/${a.agent_id}`,{expected_version:a.version});
 const resume=await f.http('POST',`/v1/runs/${receipt.run_id}/resume`,{expected_run_version:1,checkpoint_id:'checkpoint-fixture'});
 assert.equal(resume.statusCode,409,resume.body);assert.equal(resume.json().error.code,'AGENT_CAPABILITY_REVOKED');assert.equal(f.countRuns(),1);
});

test('review regression: pending steering cannot resurrect a deleted role through the terminal fallback',async t=>{
 const f=await fixture(t),a=await f.agent('Steered role'),receipt=await f.chat(a);
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(receipt.run_id);
 await f.json('POST',`/v1/runs/${receipt.run_id}/steer`,{expected_run_version:1,text:'Late follow-up',client_message_id:'late-role-follow-up'},202);
 await f.json('DELETE',`/v1/agents/${a.agent_id}`,{expected_version:a.version});
 const dispatcher=new SessionCommandDispatcher(f.db,f.events,{prompt:async()=>{throw new Error('deleted role must not prompt');},cancel:async()=>({settled:true})},()=>true,f.executionGuard);
 await dispatcher.processNext();await dispatcher.processNext();
 assert.equal(f.countRuns(),1,'terminal steering must not produce an unbound queued run for a deleted role');
});

test('review regression: active chat checkpoint resume retains the frozen role instructions',async t=>{
 const f=await fixture(t),a=await f.agent('Frozen role'),receipt=await f.chat(a);
 await f.json('PATCH',`/v1/agents/${a.agent_id}`,{instructions:'A later revision',expected_version:a.version});
 f.db.prepare("UPDATE ga_runs SET status='failed',checkpoint_id='checkpoint-fixture',reason_code=NULL WHERE id=?").run(receipt.run_id);
 const resumed=await f.json('POST',`/v1/runs/${receipt.run_id}/resume`,{expected_run_version:1,checkpoint_id:'checkpoint-fixture'},202),context=f.workbench.contextForRun(resumed.run_id);
 assert.ok(context,'checkpoint continuation must not become a legacy unbound run');assert.equal(context.agent_id,a.agent_id);assert.equal(context.kind,'chat');assert.equal(context.instructions,'Frozen role responsibility');
});

test('review regression: occurrence checkpoint resume cannot bypass its task generation and budget',async t=>{
 const f=await fixture(t),a=await f.agent('Task role'),task=await f.json('POST','/v1/persistent-tasks',{title:'Bound task',agent_id:a.agent_id,objective:'Read',trigger:{kind:'once'},budget:{max_runs:2}},201);await f.persistentTasks.tick();
 const occurrence=(await f.json('GET',`/v1/persistent-tasks/${task.task_id}/occurrences`)).items[0];f.db.prepare("UPDATE ga_runs SET status='failed',checkpoint_id='checkpoint-fixture',reason_code=NULL WHERE id=?").run(occurrence.run_id);
 const resumed=await f.http('POST',`/v1/runs/${occurrence.run_id}/resume`,{expected_run_version:1,checkpoint_id:'checkpoint-fixture'});assert.equal(resumed.statusCode,503,resumed.body);assert.equal(resumed.json().error.code,'BUDGET_SERVICE_UNAVAILABLE');assert.equal(f.countRuns(),1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_continuations').get().n,0);
});

test('review regression: terminal steering inherits frozen chat configuration and remains idempotent',async t=>{
 const f=await fixture(t),a=await f.agent('Frozen steer'),receipt=await f.chat(a);f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(receipt.run_id);
 await f.json('POST',`/v1/runs/${receipt.run_id}/steer`,{expected_run_version:1,text:'Preserve role',client_message_id:'frozen-steer-follow-up'},202);await f.json('PATCH',`/v1/agents/${a.agent_id}`,{instructions:'New instructions',expected_version:a.version});
 f.db.exec('BEGIN');f.runs.appendAssistant(receipt.run_id,'Controlled completion');f.runs.finalizePublication(receipt.run_id,'succeeded',null);f.db.exec('COMMIT');
 const dispatcher=new SessionCommandDispatcher(f.db,f.events,{prompt:async()=>{throw new Error('terminal steer must create its own turn');},cancel:async()=>({settled:true})},()=>false,f.executionGuard);await dispatcher.processNext();await dispatcher.processNext();assert.equal(f.countRuns(),2);
 const next=f.db.prepare('SELECT id FROM ga_runs WHERE id!=?').get(receipt.run_id),context=f.workbench.contextForRun(next.id);assert.ok(context);assert.equal(context.agent_id,a.agent_id);assert.equal(context.instructions,'Frozen steer responsibility');assert.equal(context.kind,'chat');
});

test('review regression: occurrence and mailbox history cannot create independent unbudgeted chat runs',async t=>{
 const f=await fixture(t),a=await f.agent('A'),b=await f.agent('B'),task=await f.json('POST','/v1/persistent-tasks',{title:'Bound task',agent_id:a.agent_id,objective:'Read',trigger:{kind:'once'}},201);await f.persistentTasks.tick();
 const occurrence=(await f.json('GET',`/v1/persistent-tasks/${task.task_id}/occurrences`)).items[0],taskMessage=await f.http('POST',`/v1/conversations/${occurrence.conversation_id}/messages`,{client_message_id:'escape-task-budget',content:[{type:'text',text:'Unbudgeted task'}]});assert.equal(taskMessage.statusCode,409,taskMessage.body);assert.equal(taskMessage.json().error.code,'TASK_CONVERSATION_READ_ONLY');assert.equal(f.countRuns(),1);
 await f.json('POST','/v1/workspaces/main/agent-messages',{sender_agent_id:a.agent_id,recipient_agent_id:b.agent_id,text:'Review one message',client_message_id:'mailbox-history-test',auto_reply:true,max_replies:1},201);f.workbench.processMailbox();
 const message=(await f.json('GET','/v1/workspaces/main/agent-messages')).items[0];assert.equal(message.status,'processing');const mailboxRun=await f.json('GET',`/v1/runs/${message.run_id}`),before=f.countRuns(),mailboxMessage=await f.http('POST',`/v1/conversations/${mailboxRun.conversation_id}/messages`,{client_message_id:'escape-mailbox-budget',content:[{type:'text',text:'Unbudgeted follow-up'}]});assert.equal(mailboxMessage.statusCode,409,mailboxMessage.body);assert.equal(mailboxMessage.json().error.code,'TASK_CONVERSATION_READ_ONLY');assert.equal(f.countRuns(),before);
});

test('review regression: long active intervals do not occupy the entire due-task scan',async t=>{
 const f=await fixture(t),a=await f.agent('Shared scheduler role');
 for(let i=0;i<25;i++)await f.json('POST','/v1/persistent-tasks',{title:`Long interval ${i}`,agent_id:a.agent_id,objective:'Wait for the current execution to finish',priority:100,trigger:{kind:'interval',interval_seconds:60}},201);
 await f.persistentTasks.tick();assert.equal(f.countRuns(),25);
 // Controlled elapsed-time fixture: every existing interval is due again,
 // while its real occurrence remains queued or in progress.
 f.db.prepare("UPDATE wb_persistent_tasks SET next_due_at=? WHERE priority=100").run(new Date(Date.now()-120000).toISOString());
 const lower=await f.json('POST','/v1/persistent-tasks',{title:'New due task',agent_id:a.agent_id,objective:'Admission should remain visible',priority:0,trigger:{kind:'once'}},201);
 await f.persistentTasks.tick();assert.equal((await f.json('GET',`/v1/persistent-tasks/${lower.task_id}/occurrences`)).items.length,1,'skipping already active intervals must not starve a due independent task');assert.equal(f.countRuns(),26);
});

test('internal side effects roll back if storing their call receipt fails',async t=>{
 const f=await fixture(t),a=await f.agent('Atomic receipt'),receipt=await f.chat(a),identity={run_id:receipt.run_id,session_ref:f.bind('alice',a.conversation_id)};
 const input={...identity,operation:'memory.save',arguments:{scope:'private',content:'Atomic note'},call_id:'atomic-memory-call'};
 // Fail precisely after the mutation, at its enclosing receipt boundary.
 f.db.exec("CREATE TEMP TRIGGER fixture_fail_receipt BEFORE INSERT ON wb_tool_receipts BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END");
 const failed=await f.internal('tool',input);assert.equal(failed.statusCode,500,failed.body);
 assert.equal(Number(f.db.prepare("SELECT count(*) n FROM wb_memories WHERE content='Atomic note'").get().n),0);
 assert.equal(Number(f.db.prepare('SELECT count(*) n FROM wb_tool_receipts WHERE call_id=?').get(input.call_id).n),0);
 f.db.exec('DROP TRIGGER fixture_fail_receipt');
 const retried=await f.internal('tool',input);assert.equal(retried.statusCode,200,retried.body);
 assert.equal(Number(f.db.prepare("SELECT count(*) n FROM wb_memories WHERE content='Atomic note'").get().n),1);
 assert.equal(Number(f.db.prepare('SELECT count(*) n FROM wb_tool_receipts WHERE call_id=?').get(input.call_id).n),1);
 const replayed=await f.internal('tool',input);assert.equal(replayed.statusCode,200,replayed.body);assert.deepEqual(replayed.json(),retried.json());
});
