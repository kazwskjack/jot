import assert from 'node:assert/strict';
import {fixture} from './discovery-fixture.mjs';
import {join} from 'node:path';import {buildServer} from '../../src/server.ts';import {withImmediateTransaction} from '../../src/db/database.ts';
import {prepareTaskCompletion,confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';
import {DiscoveryPlanning} from '../../src/always-on/planning.ts';import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {DiscoveryHistory as History} from '../../src/always-on/discovery-history.ts';
async function planned(t,count=1,planPath='source.md'){
 const f=fixture(t);f.file();await f.controller().admit('owner',f.scope);
 const occurrence=f.db.prepare('SELECT * FROM wb_task_occurrences').get(),run=occurrence.run_id,lease=f.coordinator.claimNext('history-worker',30000);f.coordinator.start(lease);
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(occurrence.conversation_id,'owner','history-session','now','now');
 const planning=new DiscoveryPlanning(f.db,f.workbench),source=planning.source(run,{revision:1,offset:0});
 const evidence=new TaskExecutionEvidence(f.db).record(run,'source','discovery.source',source);planning.recordRead(run,evidence.reference,source);
 f.tasks.upsertSubtask('owner',occurrence.task_id,{title:'Inspect source',acceptance:'Use the pinned source',status:'completed',evidence:[evidence]},run);
 for(let i=0;i<count;i++)planning.plan(run,'plan-'+i,{summary:'Proposal '+i,rationale:'Observed source',changes:[{path:planPath,description:'Change '+i,steps:['Review'],verification:['Compare']}],evidence:[evidence]});
 const report=planning.report(run,'report',{outcome:count?'proposals':'no_plan',summary:'Source inspected',limitations:[],plan_ids:[],evidence:[evidence]});
 return {...f,occurrence,run,lease,planning,report,history:new History(f.db),admission:f.db.prepare('SELECT * FROM wb_discovery_admissions').get()};
}
export async function acceptedWorkCycleFixture(t,{publish=true,count=2,planPath='source.md'}={}){
 const cleanup=[];let server;t.after(async()=>{if(server){await server.app.close();server.db.close();}for(const close of cleanup.reverse())await close();});
 const f=await planned({after:close=>cleanup.push(close)},count,planPath),config=JSON.parse(f.db.prepare('SELECT policy_json FROM wb_model_budget_policy_history ORDER BY revision DESC LIMIT 1').get().policy_json);
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
