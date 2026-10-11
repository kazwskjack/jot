import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,openSync,writeFileSync,fsyncSync,closeSync,readFileSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {buildServer} from '../../src/server.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {HarnessWorker} from '../../src/harness/worker.ts';
import {OfficialSessionRunner} from '../../src/harness/official-session-runner.ts';
import {validateCheckpoint} from '../../src/harness/session-checkpoints.ts';
import {WorkbenchBridge} from '../../../session-adapter/workbench.js';
import {createAdapterHandler} from '../../../session-adapter/index.js';
const limit={tokens:5000,nano_usd:50000,model_calls:50};
const route={provider:'fixture',model:'bounded',revision:'rates-1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}};
const policy={revision:1,admission_route:{provider:'fixture',model:'bounded'},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limit]))};
const receipt={session_ref:'session-fixture',seq_exclusive:3,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:3,log_sha256:'a'.repeat(64)};
async function fixture(t){
 const base=resolve('.test-tmp/session-checkpoints');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));
 const f=await buildServer({databasePath:join(root,'fixture.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),internalChannelToken:'test-b99992d64419ae59',modelBudgetPolicy:policy,csrfToken:'test-dcbf055943f33d8a',allowedOrigins:['https://fixture.invalid']});
 t.after(async()=>{await f.app.close();f.db.close();const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true});});
 const a=f.workbench.createAgent('alice',{name:'Reader',instructions:'Reader duties'});
 const task=f.persistentTasks.create('alice',{title:'Recover',agent_id:a.agent_id,objective:'Read report',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 const occurrence=f.persistentTasks.runNow('alice',task.task_id,'original'),now=new Date().toISOString();
 const coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimNext('fixture-worker',30000);coordinator.start(lease);
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(occurrence.conversation_id,'alice','session-fixture',now,now);
 f.db.prepare('INSERT INTO wb_native_goal_bindings VALUES(?,?,?,?,?,?)').run(occurrence.run_id,occurrence.occurrence_id,'goal-fixture',3,now,now);
 return {...f,root,a,task,occurrence,coordinator,lease};
}
test('worker-fenced checkpoint is immutable, idempotent and returns only its opaque public reference',async t=>{
 const f=await fixture(t),id=f.coordinator.recordCheckpoint(f.lease,'session-fixture',receipt);
 assert.match(id,/^checkpoint-/);assert.equal(f.coordinator.recordCheckpoint(f.lease,'session-fixture',receipt),id);
 assert.equal(f.runs.get(f.lease.run_id,'alice').checkpoint_id,id);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_session_checkpoints').get().n,1);
 assert.throws(()=>f.db.prepare('UPDATE ga_session_checkpoints SET log_sha256=?').run('b'.repeat(64)),/checkpoint_immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM ga_session_checkpoints').run(),/checkpoint_immutable/);
 const publicRun=await f.app.inject({method:'GET',url:`/v1/runs/${f.lease.run_id}`,headers:{'x-user-id':'alice'}});assert.equal(publicRun.statusCode,200,publicRun.body);
 for(const value of ['session-fixture','goal-fixture','log_sha256'])assert.equal(publicRun.body.includes(value),false);
});
test('checkpoint recording rejects mismatched ownership, Goal, receipt shape, revoked generation and expired leases',async t=>{
 for(const condition of ['session','goal','revision','shape','generation','lease','usage','role_revoked','role_epoch']){
  const f=await fixture(t),input={...receipt};
  if(condition==='session')input.session_ref='wrong-session';
  if(condition==='goal')input.goal_id='wrong-goal';
  if(condition==='revision')input.goal_revision=4;
  if(condition==='shape')input.owner_id='bob';
  if(condition==='generation')f.db.prepare('UPDATE wb_task_occurrences SET generation=-1').run();
  if(condition==='lease')f.db.prepare('UPDATE ga_worker_leases SET expires_at=0').run();
  if(condition==='role_revoked')f.db.prepare("UPDATE wb_agents SET status='deleted'").run();
  if(condition==='role_epoch')f.db.prepare('UPDATE wb_agents SET capability_epoch=capability_epoch+1').run();
  if(condition==='usage'){f.modelBudgets.reserve('alice',f.lease.run_id,{attempt_id:'pending',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',f.lease.run_id,'pending');}
  assert.throws(()=>f.coordinator.recordCheckpoint(f.lease,'session-fixture',input),undefined,condition);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_session_checkpoints').get().n,0);assert.equal(f.runs.get(f.lease.run_id,'alice').checkpoint_id,undefined);
 }
});

test('checkpoint protocol rejects coercible identity and hash values',()=>{
 for(const key of ['session_ref','goal_id','log_sha256'])assert.throws(()=>validateCheckpoint({...receipt,[key]:key==='log_sha256'?{toString:()=>receipt.log_sha256}:123}),/checkpoint_invalid/);
});

test('step-admission rejects unresolved or out-of-bound parent accounting after a real checkpoint continuation',async t=>{
 for(const condition of ['pending','unknown','bound']){
  const f=await fixture(t),checkpoint=f.coordinator.recordCheckpoint(f.lease,'session-fixture',receipt);
  f.coordinator.waitForTask(f.lease,{goal_id:'goal-fixture',goal_revision:3,phase:'paused',turn_end_seq:2},'SESSION_GOAL_WAITING_USER');
  const waiting=f.runs.get(f.lease.run_id,'alice');
  const resumed=await f.app.inject({method:'POST',url:`/v1/runs/${f.lease.run_id}/resume`,headers:{'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':`parent-admission-${condition}`},payload:{expected_run_version:waiting.version,checkpoint_id:checkpoint}});
  assert.equal(resumed.statusCode,202,resumed.body);
  const leaf=f.coordinator.claimNext('step-admission-worker',30000);f.coordinator.start(leaf);
  // Controlled late-accounting fault after a clean checkpoint. No product
  // method authorizes an old parent to execute again. Keep actual ledger
  // settlement/reservations and restore the parent's true terminal status.
  const oldStatus=f.runs.get(f.lease.run_id,'alice').status;
  const leafStatus=f.runs.get(leaf.run_id,'alice').status;
  f.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(leaf.run_id);
  f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.lease.run_id);
  f.modelBudgets.reserve('alice',f.lease.run_id,{attempt_id:'late-parent',provider:'fixture',model:'bounded'});
  f.modelBudgets.dispatch('alice',f.lease.run_id,'late-parent');
  if(condition==='unknown')f.modelBudgets.markUnknown('alice',f.lease.run_id,'late-parent','usage_incomplete');
  if(condition==='bound')f.modelBudgets.settle('alice',f.lease.run_id,'late-parent',{inputTokens:101,outputTokens:1,totalTokens:102});
  f.db.prepare('UPDATE ga_runs SET status=? WHERE id=?').run(oldStatus,f.lease.run_id);
  f.db.prepare('UPDATE ga_runs SET status=? WHERE id=?').run(leafStatus,leaf.run_id);
  const balances=f.modelBudgets.balancesForRun('alice',leaf.run_id),events=f.db.prepare('SELECT count(*) n FROM wb_model_budget_events').get().n;
  const response=await f.app.inject({method:'POST',url:'/internal/v1/workbench/step-admission',headers:{authorization:'Bearer test-b99992d64419ae59'},payload:{run_id:leaf.run_id,session_ref:'session-fixture',route:{provider:'fixture',model:'bounded'}}});
  assert.equal(response.statusCode,condition==='bound'?429:409,response.body);
  assert.equal(response.json().error.code,condition==='bound'?'MODEL_BUDGET_EXHAUSTED':condition==='unknown'?'BUDGET_USAGE_UNKNOWN':'BUDGET_USAGE_PENDING');
  const reserve=await f.app.inject({method:'POST',url:'/internal/v1/workbench/model-budget',headers:{authorization:'Bearer test-b99992d64419ae59'},payload:{run_id:leaf.run_id,session_ref:'session-fixture',execution_lease:{owner:leaf.owner,generation:leaf.generation},action:'reserve',request:{attempt_id:'must-not-dispatch',provider:'fixture',model:'bounded'}}});
  assert.equal(reserve.statusCode,condition==='bound'?429:409,reserve.body);
  assert.equal(reserve.json().error.code,response.json().error.code,'actual dispatch cannot bypass the preliminary lineage guard');
  assert.deepEqual(f.modelBudgets.balancesForRun('alice',leaf.run_id),balances);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_events').get().n,events);
  assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);
 }
});

for(const reason of ['SESSION_GOAL_WAITING_USER','SESSION_GOAL_WAITING_APPROVAL'])test(`confirmed task wait releases its worker and resumes only through its owned checkpoint: ${reason}`,async t=>{
 const f=await fixture(t),id=f.coordinator.recordCheckpoint(f.lease,'session-fixture',receipt);
 const stop={goal_id:'goal-fixture',goal_revision:3,phase:'paused',turn_end_seq:2};
 f.coordinator.waitForTask(f.lease,stop,reason);
 const expected=reason==='SESSION_GOAL_WAITING_USER'?'waiting_user':'waiting_approval';
 const waiting=f.runs.get(f.lease.run_id,'alice');assert.equal(waiting.status,expected);assert.equal(waiting.checkpoint_id,id);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(f.lease.run_id).n,0);
 assert.equal(f.coordinator.claimNext('another-worker',30000),null);
 assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].business_state,expected);
 assert.throws(()=>f.persistentTasks.runNow('alice',f.task.task_id,'do-not-trigger-again'));
 const request=(owner,version)=>f.app.inject({method:'POST',url:`/v1/runs/${f.lease.run_id}/resume`,headers:{'x-user-id':owner,origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':`wait-resume-${owner}-${version}`},payload:{expected_run_version:version,checkpoint_id:id}});
 assert.equal((await request('bob',waiting.version)).statusCode,404);
 assert.equal((await request('alice',waiting.version-1)).statusCode,409);
 const resumed=await request('alice',waiting.version);
 if(expected==='waiting_approval'){
  assert.equal(resumed.statusCode,409,resumed.body);assert.equal(resumed.json().error.code,'TASK_WAIT_RESPONSE_REQUIRED');
  assert.equal(f.runs.get(f.lease.run_id,'alice').status,'waiting_approval');assert.equal(f.coordinator.claimNext('no-approval-bypass',30000),null);return;
 }
 assert.equal(resumed.statusCode,202,resumed.body);
 assert.equal(f.runs.get(f.lease.run_id,'alice').status,'interrupted');assert.equal(f.runs.get(resumed.json().run_id,'alice').status,'queued');
 assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].occurrence_id,f.occurrence.occurrence_id);
 assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);
 const leaf=f.coordinator.claimNext('resumed-worker',30000);assert.equal(leaf.run_id,resumed.json().run_id);
});

test('task wait cannot use an old or unconfirmed checkpoint, unknown usage, revoked scope or a stale worker',async t=>{
 for(const condition of ['missing','goal','revision','boundary','unknown','role','generation','lease','cancelling']){
  const f=await fixture(t);if(condition!=='missing')f.coordinator.recordCheckpoint(f.lease,'session-fixture',receipt);
  const stop={goal_id:'goal-fixture',goal_revision:3,phase:'paused',turn_end_seq:2};
  if(condition==='goal')stop.goal_id='foreign-goal';if(condition==='revision')stop.goal_revision=4;if(condition==='boundary')stop.turn_end_seq=1;
  if(condition==='unknown'){f.modelBudgets.reserve('alice',f.lease.run_id,{attempt_id:'unsettled',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',f.lease.run_id,'unsettled');}
  if(condition==='role')f.db.prepare('UPDATE wb_agents SET capability_epoch=capability_epoch+1').run();
  if(condition==='generation')f.db.prepare('UPDATE wb_task_occurrences SET generation=-1').run();
  if(condition==='lease')f.db.prepare('UPDATE ga_worker_leases SET expires_at=0').run();
  if(condition==='cancelling')f.db.prepare("UPDATE ga_runs SET status='cancelling'").run();
  assert.throws(()=>f.coordinator.waitForTask(f.lease,stop,'SESSION_GOAL_WAITING_USER'),undefined,condition);
  assert.equal(f.runs.get(f.lease.run_id,'alice').status,condition==='cancelling'?'cancelling':'running');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(f.lease.run_id).n,1);
 }
});

test('failed waiting-task recovery rolls back the parent state, leaf, outbox and events with its cumulative budget intact',async t=>{
 for(const condition of ['budget','unknown']){
  const f=await fixture(t),id=f.coordinator.recordCheckpoint(f.lease,'session-fixture',receipt);
  f.coordinator.waitForTask(f.lease,{goal_id:'goal-fixture',goal_revision:3,phase:'paused',turn_end_seq:2},'SESSION_GOAL_WAITING_USER');
  const headers={'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':`waiting-budget-${condition}`};
  if(condition==='budget'){
   const view=(await f.app.inject({method:'GET',url:`/v1/persistent-tasks/${f.task.task_id}/model-budget`,headers})).json();
   const committed=Object.fromEntries(['tokens','nano_usd','model_calls'].map(key=>[key,Number(view.root.used[key])+Number(view.root.held[key])]));
   const response=await f.app.inject({method:'PATCH',url:`/v1/persistent-tasks/${f.task.task_id}/model-budget`,headers,payload:{expected_version:0,limits:committed}});assert.equal(response.statusCode,200,response.body);
  }else{
   // Fault injection: a late restored accounting attempt appears after wait.
   // Public admission never allows a new call while waiting.
   f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.lease.run_id);
   f.modelBudgets.reserve('alice',f.lease.run_id,{attempt_id:'uncertain',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',f.lease.run_id,'uncertain');f.modelBudgets.markUnknown('alice',f.lease.run_id,'uncertain','stream_incomplete');
   f.db.prepare("UPDATE ga_runs SET status='waiting_user' WHERE id=?").run(f.lease.run_id);
  }
  const waiting=f.runs.get(f.lease.run_id,'alice'),before={outbox:f.db.prepare('SELECT count(*) n FROM ga_outbox').get().n,events:f.db.prepare('SELECT count(*) n FROM ga_events').get().n};
  const response=await f.app.inject({method:'POST',url:`/v1/runs/${f.lease.run_id}/resume`,headers:{...headers,'idempotency-key':`waiting-recover-${condition}`},payload:{expected_run_version:waiting.version,checkpoint_id:id}});
  assert.equal(response.statusCode,condition==='budget'?429:409,response.body);
  assert.equal(response.json().error.code,condition==='budget'?'MODEL_BUDGET_EXHAUSTED':'BUDGET_USAGE_UNKNOWN');
  assert.deepEqual(f.runs.get(f.lease.run_id,'alice'),waiting);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_continuations').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_outbox').get().n,before.outbox);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,before.events);
  assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].run_id,f.lease.run_id);assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);
 }
});
test('continuation obtains only its own saved checkpoint through the authenticated internal channel',async t=>{
 const f=await fixture(t),id=f.coordinator.recordCheckpoint(f.lease,'session-fixture',receipt);f.coordinator.interruptWithoutRuntime(f.lease,'SESSION_TURN_INTERRUPTED');
 const resumed=await f.app.inject({method:'POST',url:`/v1/runs/${f.lease.run_id}/resume`,headers:{'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':'resume-fixture'},payload:{expected_run_version:f.runs.get(f.lease.run_id,'alice').version,checkpoint_id:id}});assert.equal(resumed.statusCode,202,resumed.body);
 const payload={run_id:resumed.json().run_id,session_ref:'session-fixture'};
 const unauth=await f.app.inject({method:'POST',url:'/internal/v1/workbench/checkpoint',payload});assert.equal(unauth.statusCode,401,unauth.body);
 const read=await f.app.inject({method:'POST',url:'/internal/v1/workbench/checkpoint',headers:{authorization:'Bearer test-b99992d64419ae59'},payload});assert.equal(read.statusCode,200,read.body);assert.deepEqual(read.json().checkpoint,receipt);
 const forged=await f.app.inject({method:'POST',url:'/internal/v1/workbench/checkpoint',headers:{authorization:'Bearer test-b99992d64419ae59'},payload:{...payload,checkpoint_id:'forged'}});assert.equal(forged.statusCode,403,forged.body);
});

test('a continuation cannot mark the occurrence safe while an ancestor has unresolved model usage',async t=>{
 const f=await fixture(t),id=f.coordinator.recordCheckpoint(f.lease,'session-fixture',receipt);
 f.coordinator.interruptWithoutRuntime(f.lease,'SESSION_TURN_INTERRUPTED');
 const resumed=await f.app.inject({method:'POST',url:`/v1/runs/${f.lease.run_id}/resume`,headers:{'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':'ancestor-resume'},payload:{expected_run_version:f.runs.get(f.lease.run_id,'alice').version,checkpoint_id:id}});assert.equal(resumed.statusCode,202,resumed.body);
 const lease=f.coordinator.claimNext('child-worker',30000);assert.equal(lease.run_id,resumed.json().run_id);f.coordinator.start(lease);
 // Fault injection represents an unresolved ancestor receipt discovered after
 // admission. It is not a fabricated provider charge or a settlement API.
 f.db.prepare("UPDATE wb_model_budget_attempts SET state='unknown' WHERE run_id=? AND state='reserved'").run(f.lease.run_id);
 assert.ok(f.db.prepare("SELECT 1 FROM wb_model_budget_attempts WHERE run_id=? AND state='unknown'").get(f.lease.run_id));
 assert.throws(()=>f.coordinator.recordCheckpoint(lease,'session-fixture',{...receipt,seq_exclusive:4}),/budget_usage_unknown/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_session_checkpoints').get().n,1);
 assert.equal(f.runs.get(lease.run_id,'alice').checkpoint_id,id);
});

for(const restored of ['valid','paused','waiting','usage_unknown','changed_prefix','empty'])test(`Worker, Runner, authenticated adapter and Gateway recover only a confirmed persistent prefix: ${restored}`,async t=>{
 const f=await fixture(t),events=[],file=join(f.root,'native-session.jsonl');let goal,prompts=0;
 f.db.prepare('DELETE FROM wb_native_goal_bindings').run();f.db.prepare("UPDATE ga_runs SET status='queued' WHERE id=?").run(f.lease.run_id);f.db.prepare('UPDATE ga_worker_leases SET expires_at=0').run();
 const append=(type,data)=>{events.push({seq:events.length,type,time:1,data});};
 const session={id:'session-fixture',header:{id:'session-fixture',version:1,createdAt:1},get seq(){return events.length;},eventAt:i=>events[i]};
 const agent={session,status:'idle',cancel:()=>{},whenIdle:async()=>{},ctx:{tools:{guard:()=>()=>{},presentAs:()=>()=>{},register:()=>()=>{}},systemPrompt:{section:()=>()=>{}},on:()=>()=>{},goals:{
  get:()=>goal&&structuredClone(goal),create:(_a,{objective})=>{goal={id:'goal-fixture',revision:1,objective,phase:'active',activation:'armed',maxGoalRounds:256,roundsStarted:0,createdAt:1,updatedAt:1};append('goal/change',{goal});return structuredClone(goal);},
  disarm:()=>{if(goal)goal.activation='disarmed';return goal&&structuredClone(goal);},pause:()=>{goal={...goal,phase:'paused',revision:goal.revision+1};append('goal/change',{goal});return structuredClone(goal);},
  resume:()=>{goal={...goal,phase:'active',revision:goal.revision+1};append('goal/change',{goal});return structuredClone(goal);},
 }}};
 const persistence={flush:async()=>{const descriptor=openSync(file,'w');try{writeFileSync(descriptor,[session.header,...events].map(JSON.stringify).join('\n')+'\n');fsyncSync(descriptor);}finally{closeSync(descriptor);}},
  open:async()=>{const lines=readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);return {id:session.id,header:lines[0],access:'read',read:async(offset,length)=>({events:lines.slice(1+offset,1+offset+length)}),close:async()=>{}};}};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-b99992d64419ae59',fetchImpl:async(url,init)=>{
  const response=await f.app.inject({method:'POST',url:new URL(url).pathname,headers:init.headers,payload:JSON.parse(init.body)});return new Response(response.body,{status:response.statusCode});}});
 const controller={create:async()=>({sessionId:session.id}),prompt:async({content})=>{prompts++;if(prompts===2)assert.match(content[0].text,/不要重新发送或重复执行/);append('turn/start',{turn:prompts});if(prompts===2)append('assistant/message',{turn:2,step:1,message:{content:[{type:'text',text:'Recovered report'}]}});append('turn/end',{reason:{kind:prompts===1?'interrupted':'completed'}});if(['paused','waiting'].includes(restored)&&prompts===1)agent.ctx.goals.pause();if(restored==='usage_unknown'){f.modelBudgets.reserve('alice',f.lease.run_id,{attempt_id:'unsettled-native',provider:'fixture',model:'bounded'});f.modelBudgets.dispatch('alice',f.lease.run_id,'unsettled-native');f.modelBudgets.markUnknown('alice',f.lease.run_id,'unsettled-native','usage_incomplete');}return {accepted:true};},
  async *follow(){const cursor=events.length-1;yield {type:'snapshot',cursor,records:[]};for(const event of events.slice(cursor+1))yield {type:'event',event};}};
 const token='a'.repeat(32),handler=createAdapterHandler({controller,agents:{get:()=>agent},sessions:{flush:async()=>true},persistence,token,workbenchBridge:bridge,budgetModelSelector:async(_agent,check)=>check()});
 const request=async(path,body)=>{const response=await handler({method:'POST',url:new URL('http://127.0.0.1'+path),headers:{authorization:'Bearer '+token},body});assert.ok(response.status<400,JSON.stringify(response));return response;};
 const client={create:async(id,cwd,preset,signal,runId,executionLease)=>(await request('/v1/sessions',{session_id:id,cwd,agent_preset:preset,workbench_context:{run_id:runId,execution_lease:executionLease}})).value,
  prompt:async(id,requestId,content)=>(await request(`/v1/sessions/${id}/prompts`,{request_id:requestId,content})).value,
  checkpoint:async(id,seq)=>(await request(`/v1/sessions/${id}/checkpoint`,{after_seq:seq})).value,
  ...(['waiting','usage_unknown'].includes(restored)?{goalStatus:async id=>(await request(`/v1/sessions/${id}/goal-status`,{})).value,goalStop:async(id,ref)=>(await request(`/v1/sessions/${id}/goal-stop`,ref)).value}:{}),
  async *follow(){yield* (await request(`/v1/sessions/${session.id}/follow`,{})).stream;}};
 const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general',workbenchAgentPreset:'jot-workbench-budgeted'}),coordinator=new HarnessCoordinator(f.db,f.runs,f.events);
 const worker=new HarnessWorker(f.db,coordinator,runner,{workerId:'integration-worker',leaseMs:30000,sessionResolver:()=>session.id,executionGuard:{assertRunActive:id=>{f.workbench.assertRunActive(id);f.persistentTasks.assertRunActive(id);},contextForRun:id=>f.workbench.contextForRun(id)}});
 await worker.processNext();const interrupted=f.runs.get(f.lease.run_id,'alice');assert.equal(interrupted.status,restored==='waiting'?'waiting_user':'interrupted');assert.equal(prompts,1);
 if(restored==='usage_unknown'){
  assert.equal(f.db.prepare('SELECT reason_code FROM ga_runs WHERE id=?').get(f.lease.run_id).reason_code,'OUTCOME_UNKNOWN');assert.equal(interrupted.checkpoint_id,undefined);assert.equal(goal.phase,'paused');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_session_checkpoints').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases WHERE resource_id=?').get(f.lease.run_id).n,0);
  assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].status,'outcome_unknown');assert.throws(()=>f.persistentTasks.runNow('alice',f.task.task_id,'not-safe'));
  assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);return;
 }
 assert.match(interrupted.checkpoint_id,/^checkpoint-/);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_session_checkpoints').get().n,1);
 const resumed=await f.app.inject({method:'POST',url:`/v1/runs/${f.lease.run_id}/resume`,headers:{'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':'test-dcbf055943f33d8a','idempotency-key':'integrated-resume'},payload:{expected_run_version:interrupted.version,checkpoint_id:interrupted.checkpoint_id}});assert.equal(resumed.statusCode,202,resumed.body);
 if(restored==='changed_prefix')events.find(event=>event.type==='turn/start').data.turn=99;
 if(restored==='empty')events.splice(0);
 if(!['valid','paused','waiting'].includes(restored)){
  await worker.processNext();assert.equal(f.runs.get(resumed.json().run_id,'alice').status,'interrupted');assert.equal(prompts,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_session_checkpoints').get().n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_goal_bindings').get().n,1);return;
 }
 await worker.processNext();const recovered=f.runs.get(resumed.json().run_id,'alice');assert.equal(recovered.status,'interrupted');assert.equal(recovered.error_code,'TASK_BUSINESS_REVIEW_REQUIRED');assert.equal(prompts,2);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_session_checkpoints').get().n,2);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_native_goal_bindings').get().n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0,'a restored persistent prefix is not a business acceptance certificate');assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);
});
