import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {buildServer} from '../../src/server.ts';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchBudgetPolicy} from '../../src/workbench/model-budget-policy.ts';
import {ContractValidator} from '../../src/contracts/validator.ts';
const route={provider:'fixture',model:'bounded',revision:'fixture-rates-1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}};
const callRoute={provider:'openjev',model:'openjev',revision:'call-fixture',context_window:100,max_output_tokens:1,rates:{input:0,output:0,cache_read:0,cache_write:0},billing:{unit:'dispatched_call',nano_usd:7}};
const ceiling={tokens:5000,nano_usd:50000,model_calls:50};
const config=()=>({revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,{...ceiling}]))});
async function fixture(t,configured=true,policyConfig=config()){
 const base=resolve('../../.test-tmp/budget-public');assert.match(base.replaceAll('\\','/'),/^E:\/codex\//i);mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 const templates=join(root,'templates');mkdirSync(templates);const bytes=Buffer.from('Controlled fixture; no rendering requested');writeFileSync(join(templates,'fixture.docx'),bytes);
 writeFileSync(join(templates,'catalog.json'),JSON.stringify({templates:[{template_id:'fixture-template',version:'1',format:'docx',file:'fixture.docx',sha256:createHash('sha256').update(bytes).digest('hex'),fields:{}}]}));
 const server=await buildServer({databasePath:join(root,'fixture.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),templateRoot:templates,csrfToken:'test-dcbf055943f33d8a',allowedOrigins:['https://fixture.invalid'],internalChannelToken:'test-b99992d64419ae59',...(configured?{modelBudgetPolicy:policyConfig}:{})});
 t.after(async()=>{await server.app.close();server.db.close();const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const a=server.workbench.createAgent('alice',{name:'Reader'});const task=server.persistentTasks.create('alice',{title:'Controlled task',agent_id:a.agent_id,objective:'Read source',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 const path=`/v1/persistent-tasks/${task.task_id}/model-budget`;let key=0;
 const call=(method='GET',payload,owner='alice')=>server.app.inject({method,url:path,payload,headers:{'x-user-id':owner,origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':`fixture-budget-${++key}`}});
 const get=async()=>{const r=await call();assert.equal(r.statusCode,200,r.body);return r.json();};
 const update=(limits,version=0)=>call('PATCH',{limits,expected_version:version});
 const run=key=>server.persistentTasks.runNow('alice',task.task_id,key);
 function settle(r,id='first'){
  server.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(r.run_id);
  server.modelBudgets.reserve('alice',r.run_id,{attempt_id:id,provider:route.provider,model:route.model,max_tokens:20});server.modelBudgets.dispatch('alice',r.run_id,id);
  server.modelBudgets.settle('alice',r.run_id,id,{inputTokens:20,outputTokens:5,totalTokens:25});server.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(r.run_id);
 }
 return {...server,root,a,task,path,call,get,update,run,settle};
}

test('unconfigured task budgets stay unavailable and public GET is owner scoped without fake zero billing',async t=>{
 const f=await fixture(t,false);const response=await f.call();assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json(),{configured:false,task_id:f.task.task_id,reason:'BUDGET_POLICY_NOT_CONFIGURED'});
 assert.equal((await f.call('GET',undefined,'bob')).statusCode,404);
 assert.equal((await f.update({...ceiling})).statusCode,503);
});
test('public budget distinguishes counted auxiliary calls from measured tokens without exposing provider routes',async t=>{
 const policy=config();policy.routes.push(callRoute);const f=await fixture(t,true,policy);const r=f.run('call');
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(r.run_id);
 f.modelBudgets.reserve('alice',r.run_id,{attempt_id:'aux-call',provider:'openjev',model:'openjev',purpose:'emotion'});
 f.modelBudgets.dispatch('alice',r.run_id,'aux-call');f.modelBudgets.settleDispatchedCall('alice',r.run_id,'aux-call');
 const view=await f.get();assert.equal(view.token_accounting,'metered_routes_only');assert.equal(view.unmetered_token_calls,1);
 assert.equal(view.root.used.tokens,'0');assert.equal(view.root.used.nano_usd,'7');assert.equal(view.root.used.model_calls,'1');
 assert.doesNotMatch(JSON.stringify(view),/openjev|call-fixture|aux-call|provider|run_id|owner_id/);
 const v=new ContractValidator();assert.equal(v.validateResponse(v.operationFor('GET','/v1/persistent-tasks/{task_id}/model-budget'),200,view).valid,true);
});
test('task-linked member unknown usage appears in the root public budget and blocks its next-call preview',async t=>{
 const f=await fixture(t);const root=f.run('member');f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(root.run_id);
 const role=f.workbench.createAgent('alice',{name:'Reviewer',workspace_id:'ws',project_id:f.a.project_id});
 const msg=f.workbench.sendMessage('alice','ws',{sender_agent_id:f.a.agent_id,recipient_agent_id:role.agent_id,text:'Review',client_message_id:'budget-member',auto_reply:true,max_replies:1,task_run_id:root.run_id});
 f.workbench.processMailbox();const child=f.db.prepare('SELECT run_id FROM wb_agent_messages WHERE message_id=?').get(msg.message_id).run_id;
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(child);
 f.modelBudgets.reserve('alice',child,{attempt_id:'unknown-member',provider:route.provider,model:route.model});f.modelBudgets.dispatch('alice',child,'unknown-member');f.modelBudgets.markUnknown('alice',child,'unknown-member','usage_incomplete');
 const view=await f.get();assert.equal(view.pending_unknown,1);assert.equal(view.can_start_next_call,false);assert.ok(view.blocking_reasons.includes('usage_unknown'));
 assert.throws(()=>f.modelBudgets.previewCall('alice',root.run_id,{provider:route.provider,model:route.model}),/budget_usage_unknown/);
 assert.throws(()=>f.modelBudgets.reserve('alice',root.run_id,{attempt_id:'blocked-root',provider:route.provider,model:route.model}),/budget_usage_unknown/);
 f.modelBudgets.settle('alice',child,'unknown-member',{inputTokens:20,outputTokens:5,totalTokens:25});
 assert.equal((await f.get()).pending_unknown,0);
 assert.equal(f.modelBudgets.reserve('alice',root.run_id,{attempt_id:'settled-root',provider:route.provider,model:route.model}).state,'reserved');
});

test('configured public view reads exact root and shared budgets without internal identity or side effects',async t=>{
 const f=await fixture(t);const before=f.db.prepare('SELECT count(*) n FROM wb_model_budget_scopes').get().n;
 const initial=await f.get();assert.equal(initial.configured,true);assert.equal(initial.version,0);assert.equal(initial.can_start_next_call,true);assert.equal(initial.root.used.tokens,'0');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_scopes').get().n,before);
 const r=f.run('one');f.settle(r);const view=await f.get();assert.equal(view.root.used.tokens,'25');assert.equal(view.root.used.nano_usd,'90');assert.equal(view.root.remaining.model_calls,'49');
 assert.deepEqual(view.shared.map(x=>x.kind),['owner_daily','project_daily','agent_daily']);assert.equal(view.shared[0].used.tokens,'25');
 assert.doesNotMatch(JSON.stringify(view),/scope_id|scope_key|owner_id|session|pricing_revision|fixture-rates|run_id|agent_id|file[s]?\/|provider/);
 assert.equal(view.cost_basis,'configured_rates');assert.equal(view.currency,'USD');assert.equal(view.pending_unknown,0);
 const v=new ContractValidator();const op=v.operationFor('GET','/v1/persistent-tasks/{task_id}/model-budget');assert.ok(op);assert.equal(v.validateResponse(op,200,view).valid,true);
 assert.equal(v.validateResponse(op,200,{...view,scope_id:'internal'}).valid,false);
});

test('task limit edits gate the next real enqueue and never reset already spent tokens or revisions',async t=>{
 const f=await fixture(t);const edited=await f.update({tokens:500,nano_usd:5000,model_calls:1});assert.equal(edited.statusCode,200,edited.body);assert.equal(edited.json().version,1);
 const first=f.run('one');f.settle(first);assert.throws(()=>f.run('two'),/model_budget_exhausted/);const view=await f.get();assert.equal(view.root.used.model_calls,'1');assert.equal(view.can_start_next_call,false);assert.ok(view.blocking_reasons.includes('task_total:model_calls'));
 const restored=await f.update({tokens:500,nano_usd:5000,model_calls:2},1);assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().root.used.tokens,'25');assert.equal(restored.json().version,2);
 assert.ok(f.run('three').run_id);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);
 const stale=await f.update({...ceiling},1);assert.equal(stale.statusCode,409,stale.body);assert.equal((await f.get()).version,2);
});

test('adjustments cannot fall below commitments or exceed the server ceiling and are immutable audit records',async t=>{
 const f=await fixture(t);const r=f.run('held');const low=await f.update({tokens:99,nano_usd:1000,model_calls:1});assert.equal(low.statusCode,409,low.body);
 assert.equal((await f.get()).version,0);const high=await f.update({...ceiling,tokens:ceiling.tokens+1});assert.equal(high.statusCode,422,high.body);
 f.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(r.run_id);f.workbench.reconcileBudgets();
 const edited=await f.update({tokens:100,nano_usd:1000,model_calls:1});assert.equal(edited.statusCode,200,edited.body);
 assert.throws(()=>f.db.prepare("UPDATE wb_model_budget_limit_revisions SET limits_json='{}'").run(),/budget_limit_revision_immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_model_budget_limit_revisions').run(),/budget_limit_revision_immutable/);
 assert.equal((await f.get()).root.used.tokens,'0');assert.equal((await f.get()).root.held.tokens,'0');
});

test('unknown usage remains reserved and public budget reads cannot free uncertain spend',async t=>{
 const f=await fixture(t),r=f.run('unknown');f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(r.run_id);
 f.modelBudgets.reserve('alice',r.run_id,{attempt_id:'started',provider:route.provider,model:route.model});f.modelBudgets.dispatch('alice',r.run_id,'started');f.modelBudgets.markUnknown('alice',r.run_id,'started','stream_incomplete');
 const view=await f.get();assert.equal(view.pending_unknown,1);assert.equal(view.can_start_next_call,false);assert.ok(view.blocking_reasons.includes('usage_unknown'));assert.equal(view.root.held.tokens,'100');
 f.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(r.run_id);f.workbench.reconcileBudgets();assert.equal((await f.get()).root.held.tokens,'100');
 assert.throws(()=>f.run('uncertain-retry'),/budget_usage_unknown/);
});

test('same idempotency key replays an adjustment without another revision or task generation change',async t=>{
 const f=await fixture(t);const before=f.persistentTasks.get('alice',f.task.task_id);
 const request={method:'PATCH',url:f.path,payload:{expected_version:0,limits:{tokens:200,nano_usd:2000,model_calls:2}},headers:{'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':'fixture-same-key'}};
 const first=await f.app.inject(request),second=await f.app.inject(request);assert.equal(first.statusCode,200,first.body);assert.deepEqual(second.json(),first.json());
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_limit_revisions').get().n,1);
 assert.equal(f.persistentTasks.get('alice',f.task.task_id).generation,before.generation);
 const conflict=await f.app.inject({...request,payload:{...request.payload,limits:ceiling}});assert.equal(conflict.statusCode,409);assert.equal((await f.get()).version,1);
});

test('public budget adjustments reject identity/rate injection, invalid counts and missing browser write authorization',async t=>{
 const f=await fixture(t);for(const payload of [{limits:ceiling,expected_version:0,owner_id:'bob'},{limits:{...ceiling,rates:{output:0}},expected_version:0},{limits:{...ceiling,tokens:0.1},expected_version:0},{limits:{...ceiling,tokens:-1},expected_version:0}]){
  const response=await f.call('PATCH',payload);assert.equal(response.statusCode,422,response.body);
 }
 assert.equal((await f.call('PATCH',{limits:ceiling,expected_version:0},'bob')).statusCode,404);
 const unauthorized=await f.app.inject({method:'PATCH',url:f.path,payload:{limits:ceiling,expected_version:0},headers:{'x-user-id':'alice'}});assert.equal(unauthorized.statusCode,403,unauthorized.body);
 assert.equal((await f.get()).version,0);
});

test('budget adjustments survive restart and two allocators cannot both win the same revision',async t=>{
 const f=await fixture(t),updated=await f.update({tokens:200,nano_usd:2000,model_calls:2});assert.equal(updated.statusCode,200,updated.body);
 const db=openProductDatabase(join(f.root,'fixture.sqlite'));
 try{
  const policy=new WorkbenchBudgetPolicy(db,config());const budget=await import('../../src/workbench/budget-public.ts');assert.equal(typeof budget.TaskBudgetService,'function');
  const other=new budget.TaskBudgetService(db,policy);assert.equal(other.get('alice',f.task.task_id).version,1);
  const next=other.update('alice',f.task.task_id,{expected_version:1,limits:{tokens:300,nano_usd:3000,model_calls:3}});assert.equal(next.version,2);
  assert.equal((await f.update({...ceiling},1)).statusCode,409);assert.equal((await f.get()).root.limits.tokens,'300');
 }finally{db.close();}
});

test('a newer server ceiling applies to old bindings and pending user adjustments without resetting spend',async t=>{
 const f=await fixture(t);assert.equal((await f.update({tokens:500,nano_usd:5000,model_calls:2})).statusCode,200);
 const first=f.run('prior-policy');f.settle(first);const updated=config();updated.revision=2;updated.limits.task_total.model_calls=1;
 const policy=new WorkbenchBudgetPolicy(f.db,updated),{TaskBudgetService}=await import('../../src/workbench/budget-public.ts');
 const view=new TaskBudgetService(f.db,policy).get('alice',f.task.task_id);assert.equal(view.root.limits.model_calls,'1');assert.equal(view.root.used.model_calls,'1');assert.equal(view.version,1);assert.equal(view.can_start_next_call,false);
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(first.run_id);
 assert.throws(()=>policy.ledger.reserve('alice',first.run_id,{attempt_id:'later',provider:route.provider,model:route.model}),/model_budget_exhausted/);
});

test('a fresh view includes the single-occurrence admission bound even when cumulative and daily allowances remain',async t=>{
 const policy=config();policy.limits.occurrence.model_calls=0;const f=await fixture(t,true,policy),view=await f.get();
 assert.equal(view.can_start_next_call,false);assert.ok(view.blocking_reasons.includes('occurrence:model_calls'));
 assert.throws(()=>f.run('cannot-admit'),/model_budget_exhausted/);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});

const newTask=(f,model_budget)=>({title:'Atomic task',agent_id:f.a.agent_id,objective:'Controlled read',trigger:{kind:'once'},...(model_budget===undefined?{}:{model_budget})});
const createRequest=(f,input,key='test-atomic-create-budget',owner='alice')=>f.app.inject({method:'POST',url:'/v1/persistent-tasks',payload:input,headers:{'x-user-id':owner,origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':key}});
test('create commits the selected model limits before any occurrence, and replays one task and one revision',async t=>{
 const f=await fixture(t),input=newTask(f,{tokens:100,nano_usd:1000,model_calls:1});
 const response=await createRequest(f,input);assert.equal(response.statusCode,201,response.body);const task=response.json();
 const view=(await f.app.inject({method:'GET',url:`/v1/persistent-tasks/${task.task_id}/model-budget`,headers:{'x-user-id':'alice'}})).json();
 assert.equal(view.version,1);assert.deepEqual(view.root.limits,{tokens:'100',nano_usd:'1000',model_calls:'1'});assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
 const replay=await createRequest(f,input);assert.equal(replay.statusCode,201,replay.body);assert.equal(replay.json().task_id,task.task_id);
 assert.equal(f.persistentTasks.create('alice',input,'test-atomic-create-budget').task_id,task.task_id);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_limit_revisions').get().n,1);
 const occurrence=f.persistentTasks.runNow('alice',task.task_id,'bounded-first');assert.ok(occurrence.run_id);
 assert.equal(f.modelBudgets.balance('alice',JSON.parse(f.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE run_id=?').get(occurrence.run_id).scopes_json).find(id=>f.modelBudgets.balance('alice',id).limits.model_calls==='1')).held.model_calls,'1');
});
test('invalid or unavailable initial model allowance never leaves a scheduled task or budget audit behind',async t=>{
 for(const configured of [true,false]){
  const f=await fixture(t,configured),before=f.persistentTasks.list('alice').items.length;
  const response=await createRequest(f,newTask(f,{...ceiling,tokens:5001}),`initial-invalid-${configured}`);assert.equal(response.statusCode,configured?422:503,response.body);
  assert.equal(f.persistentTasks.list('alice').items.length,before);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_create_requests').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
  if(configured)assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_limit_revisions').get().n,0);
 }
});
test('a database failure after budget initialization rolls back task, limits, trigger and idempotency record together',async t=>{
 const f=await fixture(t);f.db.exec("CREATE TRIGGER fail_create_request BEFORE INSERT ON wb_task_create_requests WHEN (SELECT count(*) FROM wb_model_budget_limit_revisions)>0 BEGIN SELECT RAISE(ABORT,'controlled_commit_failure'); END;");
 assert.throws(()=>f.persistentTasks.create('alice',newTask(f,{tokens:100,nano_usd:1000,model_calls:1}),'failure-after-limit'),/controlled_commit_failure/);
 assert.equal(f.persistentTasks.list('alice').items.length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_limit_revisions').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_create_requests').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
test('creation exposes server-owned defaults, keeps omitted limits backward compatible and rejects owner or rate injection',async t=>{
 const f=await fixture(t),caps=await f.app.inject({method:'GET',url:'/v1/capabilities',headers:{'x-user-id':'alice'}});assert.equal(caps.statusCode,200,caps.body);assert.deepEqual(caps.json().workbench.task_model_budget_limits,ceiling);
 assert.equal((await createRequest(f,newTask(f))).statusCode,201);
 for(const budget of [{...ceiling,owner_id:'bob'},{...ceiling,scope_key:'free'},{...ceiling,rates:{output:0}},{...ceiling,tokens:0.1}]){
  assert.equal((await createRequest(f,newTask(f,budget),'reject-'+Math.random())).statusCode,400);
 }
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_limit_revisions').get().n,0);
 assert.equal((await createRequest(f,newTask(f,{...ceiling}),'foreign-create','bob')).statusCode,404);
});

test('unlimited monetary ceilings are null in public contract while usage stays numeric',async t=>{
 const cfg=config();for(const value of Object.values(cfg.limits))value.nano_usd=null;
 const f=await fixture(t,true,cfg),view=await f.get();assert.equal(view.root.limits.nano_usd,null);assert.equal(view.root.remaining.nano_usd,null);assert.equal(view.root.used.nano_usd,'0');assert.equal(view.ceiling.nano_usd,null);assert.equal(view.can_start_next_call,true);
 const v=new ContractValidator();assert.equal(v.validateResponse(v.operationFor('GET','/v1/persistent-tasks/{task_id}/model-budget'),200,view).valid,true);
 const changed=await f.update({tokens:5000,nano_usd:null,model_calls:50});assert.equal(changed.statusCode,200,changed.body);
 assert.equal(v.validateResponse(v.operationFor('GET','/v1/persistent-tasks/{task_id}/model-budget'),200,{...view,root:{...view.root,used:{...view.root.used,nano_usd:null}}}).valid,false);
});
