import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './discovery-fixture.mjs';
import {join} from 'node:path';import {buildServer} from '../../src/server.ts';import {withImmediateTransaction} from '../../src/db/database.ts';
import {prepareTaskCompletion,confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';
import {canonicalJson} from '../../src/db/canonical-json.ts';import {createHash} from 'node:crypto';
import {DiscoveryPlanning} from '../../src/always-on/planning.ts';import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
const History=(await import('../../src/always-on/discovery-history.ts')).DiscoveryHistory;
const digest=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
function insertMetadataCycle(f,index){
 // Synthetic historical rows for cursor ordering only. No execution, approval
 // or accepted business result is claimed by this pagination fixture.
 const original=f.db.prepare('SELECT * FROM wb_discovery_admissions ORDER BY rowid LIMIT 1').get(),occurrence=f.db.prepare('SELECT * FROM wb_task_occurrences ORDER BY rowid LIMIT 1').get();
 const signal=f.policies.recordSignal('owner',f.scope,{kind:'external_update',source_id:'pagination-'+index,source_version:1,source_sha256:'b'.repeat(64),origin:'external'});
 withImmediateTransaction(f.db,()=>{
  const next=f.runs.enqueue(occurrence.conversation_id,'owner',{client_message_id:'history-metadata-'+index,content:[{type:'text',text:'Synthetic history metadata'}]});
  const a={...original,admission_id:'history-admission-'+index,occurrence_id:'history-occurrence-'+index,signal_revision:signal.signal_revision,created_at:'2026-10-17T00:00:00Z'};
  f.db.prepare(`INSERT INTO wb_discovery_admissions(${Object.keys(a).join(',')}) VALUES(${Object.keys(a).map(()=>'?').join(',')})`).run(...Object.values(a));
  const o={...occurrence,occurrence_id:a.occurrence_id,run_id:next.run_id,trigger_key:'discovery:'+a.admission_id};
  f.db.prepare(`INSERT INTO wb_task_occurrences(${Object.keys(o).join(',')}) VALUES(${Object.keys(o).map(()=>'?').join(',')})`).run(...Object.values(o));
 });
}
async function planned(t,count=1){
 const f=fixture(t);f.file();await f.controller().admit('owner',f.scope);
 const occurrence=f.db.prepare('SELECT * FROM wb_task_occurrences').get(),run=occurrence.run_id,lease=f.coordinator.claimNext('history-worker',30000);f.coordinator.start(lease);
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(occurrence.conversation_id,'owner','history-session','now','now');
 const planning=new DiscoveryPlanning(f.db,f.workbench),source=planning.source(run,{revision:1,offset:0});
 const evidence=new TaskExecutionEvidence(f.db).record(run,'source','discovery.source',source);planning.recordRead(run,evidence.reference,source);
 f.tasks.upsertSubtask('owner',occurrence.task_id,{title:'Inspect source',acceptance:'Use the pinned source',status:'completed',evidence:[evidence]},run);
 for(let i=0;i<count;i++)planning.plan(run,'plan-'+i,{summary:'Proposal '+i,rationale:'Observed source',changes:[{path:'source.md',description:'Change '+i,steps:['Review'],verification:['Compare']}],evidence:[evidence]});
 const report=planning.report(run,'report',{outcome:count?'proposals':'no_plan',summary:'Source inspected',limitations:[],plan_ids:[],evidence:[evidence]});
 return {...f,occurrence,run,lease,planning,report,history:new History(f.db),admission:f.db.prepare('SELECT * FROM wb_discovery_admissions').get()};
}
async function reviewed(t,publish=true){
 const cleanup=[];let server;t.after(async()=>{if(server){await server.app.close();server.db.close();}for(const close of cleanup.reverse())await close();});
 const f=await planned({after:close=>cleanup.push(close)},0),config=JSON.parse(f.db.prepare('SELECT policy_json FROM wb_model_budget_policy_history ORDER BY revision DESC LIMIT 1').get().policy_json);
 server=await buildServer({databasePath:join(f.root,'db.sqlite'),workspaces:['ws'],workbenchRoot:join(f.root,'workspace'),uploadRoot:join(f.root,'uploads'),templateRoot:new URL('../../file-engine/templates/',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),internalChannelToken:'test-history-11df6da2',modelBudgetPolicy:config,csrfToken:'test-history-dcbf0559',allowedOrigins:['https://fixture.invalid']});
 const identity={run_id:f.run,session_ref:'history-session',execution_lease:{owner:'history-worker',generation:f.lease.generation}},goal={goal_id:'history-goal',goal_revision:1};
 const internal=(name,extra)=>server.app.inject({method:'POST',url:'/internal/v1/workbench/'+name,headers:{authorization:'Bearer test-history-11df6da2'},payload:{...identity,...extra}});
 assert.equal((await internal('goal-binding',{...goal,action:'save'})).statusCode,200);
 f.budget.ledger.reserve('owner',f.run,{attempt_id:'history-model',provider:'fixture',model:'bounded'});f.budget.ledger.dispatch('owner',f.run,'history-model');f.budget.ledger.settle('owner',f.run,'history-model',{inputTokens:5,outputTokens:5,totalTokens:10});
 const proposal=await internal('goal-proposal',{...goal,call_id:'complete',intent:'complete',summary:'Review discovery'});assert.equal(proposal.statusCode,200,proposal.body);
 await internal('goal-binding',{...goal,goal_revision:2,action:'save'});
 f.coordinator.recordCheckpoint(f.lease,'history-session',{session_ref:'history-session',seq_exclusive:3,turn_end_seq:2,goal_id:goal.goal_id,goal_revision:2,log_sha256:'a'.repeat(64)});
 f.coordinator.waitForTask(f.lease,{goal_id:goal.goal_id,goal_revision:2,phase:'paused',turn_end_seq:2},'SESSION_GOAL_WAITING_APPROVAL',{text:'The source was inspected. No supported changes.'});
 const cards=(await server.app.inject({url:'/v1/conversations/'+f.occurrence.conversation_id+'/interactions',headers:{'x-user-id':'owner'}})).json().items,card=cards[0];
 const response=await server.app.inject({method:'POST',url:'/v1/interactions/'+card.interaction_id+'/response',headers:{'x-user-id':'owner','x-csrf-token':'test-history-dcbf0559',origin:'https://fixture.invalid','idempotency-key':'history-accept'},payload:{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))}});
 assert.equal(response.statusCode,202,response.body);
 if(publish){const before={host_status:'idle',goal:{...goal,goal_revision:2,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}},intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'owner',f.run,before));
  withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'owner',f.run,intent.intent_id,{host_status:'idle',goal:{...before.goal,goal_revision:3,phase:'complete'},checkpoint:{session_ref:'history-session',seq_exclusive:4,turn_end_seq:2,goal_id:goal.goal_id,goal_revision:3,log_sha256:'b'.repeat(64)}}));
  f.coordinator.finalizeReviewedTask('owner',f.run,intent.intent_id);
 }
 return {...f,server};
}
test('history is an owner-scoped read-only projection with no default creation',t=>{
 const f=fixture(t),before=f.db.prepare('SELECT total_changes() n').get().n;
 assert.equal(typeof History,'function');const history=new History(f.db);
 assert.deepEqual(history.list('owner',f.scope),{items:[],next_before_id:null,execution_authorized:false});
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 assert.throws(()=>history.list('foreign',f.scope),/discovery_history_not_found/);
});
test('detail paginates all immutable plans and rejects foreign plan cursors without exposing source bodies',async t=>{
 const f=await planned(t,23),first=f.history.detail('owner',f.scope,f.admission.admission_id);
 assert.equal(first.plans.length,20);assert.ok(first.next_after_plan_id);assert.equal(first.cycle.report.plan_count,23);assert.equal(first.cycle.accepted,false);
 const second=f.history.detail('owner',f.scope,f.admission.admission_id,first.next_after_plan_id);assert.equal(second.plans.length,3);assert.equal(second.next_after_plan_id,null);assert.equal(new Set([...first.plans,...second.plans].map(plan=>plan.plan_id)).size,23);
 assert.throws(()=>f.history.detail('owner',f.scope,f.admission.admission_id,'foreign-plan'),/invalid_discovery_history_cursor/);
 assert.doesNotMatch(JSON.stringify(first),/PRIVATE fixture|blob_name|source_sha256|[A-Z]:\\/);
 const before=f.db.prepare('SELECT total_changes() n').get().n;f.history.list('owner',f.scope);f.history.detail('owner',f.scope,f.admission.admission_id);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});
test('owner review without canonical publication is not accepted; canonical frozen report is accepted even after role epoch changes',async t=>{
 const unaccepted=await reviewed(t,false);assert.equal(unaccepted.history.list('owner',unaccepted.scope).items[0].accepted,false);
 const f=await reviewed(t),before=f.db.prepare('SELECT total_changes() n').get().n;
 assert.equal(f.history.list('owner',f.scope).items[0].accepted,true);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 f.db.prepare('UPDATE wb_agents SET capability_epoch=capability_epoch+1,version=version+1 WHERE agent_id=?').run(f.agent.agent_id);
 assert.equal(f.history.list('owner',f.scope).items[0].accepted,true,'history is not renewed execution authority');
});
test('a corrupt canonical native proof yields only a bounded error instead of accepted status',async t=>{
 const f=await reviewed(t);f.db.exec('DROP TRIGGER wb_task_native_completions_no_update');
 f.db.prepare("UPDATE wb_task_native_completions SET proof_json=?").run('{private corrupted path');
 assert.throws(()=>f.history.list('owner',f.scope),error=>error.message==='discovery_history_corrupt');
 const response=await f.server.app.inject({url:'/v1/agents/'+f.agent.agent_id+'/discovery-history',headers:{'x-user-id':'owner'}});assert.equal(response.statusCode,409);assert.deepEqual(response.json(),{error:{code:'DISCOVERY_HISTORY_CORRUPT'}});
});
test('a self-consistent proof hash cannot make a missing native checkpoint boundary accepted',async t=>{
 const f=await reviewed(t),proof=JSON.parse(f.db.prepare('SELECT proof_json FROM wb_task_native_completions').get().proof_json);delete proof.checkpoint.seq_exclusive;
 f.db.exec('DROP TRIGGER wb_task_native_completions_no_update');f.db.prepare('UPDATE wb_task_native_completions SET proof_json=?,proof_hash=?').run(canonicalJson(proof),digest(proof));
 assert.throws(()=>f.history.list('owner',f.scope),error=>error.message==='discovery_history_corrupt');
});
test('plan and report payload corruption cannot be returned as trusted history',async t=>{
 const f=await planned(t);f.db.exec('DROP TRIGGER wb_discovery_plans_update');f.db.prepare('UPDATE wb_discovery_plans SET payload_sha256=?').run('a'.repeat(64));
 assert.throws(()=>f.history.detail('owner',f.scope,f.admission.admission_id),/discovery_history_corrupt/);
 f.db.exec('DROP TRIGGER wb_discovery_reports_update');f.db.prepare("UPDATE wb_discovery_reports SET payload_json='private-invalid-json'").run();
 assert.throws(()=>f.history.list('owner',f.scope),error=>error.message==='discovery_history_corrupt');
});
test('a mismatched source run cannot leak a plan from another owner through a historical admission',async t=>{
 const f=await planned(t),foreign=f.workbench.createAgent('foreign',{name:'Foreign role'}),run=f.runs.enqueue(foreign.conversation_id,'foreign',{client_message_id:'foreign-history',content:[{type:'text',text:'Private foreign task'}]});
 f.db.exec('DROP TRIGGER wb_discovery_plans_update');f.db.prepare('UPDATE wb_discovery_plans SET run_id=?').run(run.run_id);
 assert.throws(()=>f.history.detail('owner',f.scope,f.admission.admission_id),error=>error.message==='discovery_history_corrupt');
});
test('list cursors follow stable admission sequence and remain isolated to the current role',async t=>{
 const f=fixture(t);f.file();await f.controller().admit('owner',f.scope);for(let i=1;i<=22;i++)insertMetadataCycle(f,i);
 const history=new History(f.db),first=history.list('owner',f.scope);assert.equal(first.items.length,20);assert.equal(first.items[0].admission_id,'history-admission-22');assert.ok(first.next_before_id);
 insertMetadataCycle(f,23);const second=history.list('owner',f.scope,first.next_before_id);assert.equal(second.items.length,3);assert.equal(second.next_before_id,null);assert.equal(new Set([...first.items,...second.items].map(item=>item.admission_id)).size,23);
 const other=f.workbench.createAgent('owner',{name:'Other history role'}),scope={agent_id:other.agent_id,project_id:other.project_id,workspace_id:other.workspace_id};
 assert.throws(()=>history.list('owner',scope,first.next_before_id),/invalid_discovery_history_cursor/);
 assert.throws(()=>history.detail('owner',scope,first.items[0].admission_id),/discovery_history_not_found/);
});
test('history follows the current continuation without treating a prior run report as completion',async t=>{
 const f=await planned(t),next=f.runs.enqueue(f.occurrence.conversation_id,'owner',{client_message_id:'synthetic-history-continuation',content:[{type:'text',text:'Synthetic continuation metadata'}]});
 f.db.prepare('INSERT INTO wb_task_continuations VALUES(?,?,?,?)').run(next.run_id,f.occurrence.occurrence_id,f.run,'2026-10-17T00:00:00Z');
 f.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(f.run);
 const item=f.history.list('owner',f.scope).items[0];assert.equal(item.run.run_id,next.run_id);assert.equal(item.run.status,'queued');assert.equal(item.accepted,false);assert.equal(item.report.report_id,f.report.report_id);
});
test('actual HTTP history routes deny missing and foreign owners and do not write on a valid read',async t=>{
 const f=await reviewed(t),origin=await f.server.app.listen({host:'127.0.0.1',port:0}),url=origin+'/v1/agents/'+f.agent.agent_id+'/discovery-history';
 const missing=await fetch(url);assert.equal(missing.status,401);
 const foreign=await fetch(url,{headers:{'x-user-id':'foreign'}});assert.equal(foreign.status,404);assert.doesNotMatch(await foreign.text(),/Source inspected|history-session/);
 const before=f.server.db.prepare('SELECT total_changes() n').get().n,owned=await fetch(url,{headers:{'x-user-id':'owner'}});assert.equal(owned.status,200);assert.equal((await owned.json()).items[0].accepted,true);assert.equal(f.server.db.prepare('SELECT total_changes() n').get().n,before);
 for(const query of ['?before_id=unknown','?before_id=x&before_id=y','?unknown=field']){const response=await fetch(url+query,{headers:{'x-user-id':'owner'}});assert.equal(response.status,422);assert.equal((await response.json()).error.code,'INVALID_DISCOVERY_HISTORY_CURSOR');}
});
test('queued admissions are visible without being accepted and foreign cursors cannot position a page',async t=>{
 const f=fixture(t);f.file();assert.equal((await f.controller().admit('owner',f.scope)).admitted,true);
 const history=new History(f.db),before=f.db.prepare('SELECT total_changes() n').get().n,page=history.list('owner',f.scope);
 assert.equal(page.items.length,1);assert.equal(page.items[0].accepted,false);assert.equal(page.items[0].report,null);assert.equal(page.items[0].run.status,'queued');
 assert.deepEqual(history.detail('owner',f.scope,page.items[0].admission_id),{cycle:page.items[0],plans:[],report:null,next_after_plan_id:null,execution_authorized:false});
 assert.throws(()=>history.list('owner',f.scope,'foreign-id'),/invalid_discovery_history_cursor/);
 assert.throws(()=>history.detail('foreign',f.scope,page.items[0].admission_id),/discovery_history_not_found/);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});
