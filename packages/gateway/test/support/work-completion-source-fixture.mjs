import assert from 'node:assert/strict';
import {join} from 'node:path';
import Fastify from 'fastify';
import {workGrantFixture} from '../always-on/work-grant-fixture.mjs';
import {WorkGrants} from '../../src/always-on/work-grants.ts';
import {TrustedWorkRunWorkspaceResolver} from '../../src/always-on/work-run-workspace.ts';
import {installIsolatedWorkFiles} from '../../src/always-on/isolated-work-file-schema.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {configureTaskOutputReader} from '../../src/persistent-tasks/output-content.ts';
import {readIsolatedTaskFileVersion} from '../../src/persistent-tasks/isolated-output-source.ts';
import {createNativeWorkRuntime} from '../../src/always-on/native-work-runtime.ts';
import {PersistentTaskService} from '../../src/persistent-tasks/service.ts';
import {registerWorkbenchExecution} from '../../src/workbench/execution.ts';
import {configureTaskOutputDelivery} from '../../src/persistent-tasks/output-delivery.ts';
import {ArtifactService} from '../../src/artifacts/service.ts';
import {InteractionService} from '../../src/interactions/service.ts';
import {TaskWaitResponder} from '../../src/persistent-tasks/task-wait.ts';
import {RunCommandService} from '../../src/runs/commands.ts';
import {prepareTaskCompletion,confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';
async function fixture(t,options={}){
 const f=await workGrantFixture(t,options);installIsolatedWorkFiles(f.db);const grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'select-work');
 const now=Date.now(),admission=f.tasks.enqueueDiscoveryWork('owner',grant.grant_id,()=>({activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:now}));
 const claimed=f.coordinator.claimNext('workspace-worker',60000);assert.equal(claimed.run_id,admission.run_id);f.coordinator.start(claimed);const lease={owner:claimed.owner,generation:claimed.generation};f.budget.ledger.releaseUndispatched('owner',admission.run_id,'queue-admission');
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(admission.conversation_id,'owner','work-test-session',new Date(now).toISOString(),new Date(now).toISOString());
 const resolver=new TrustedWorkRunWorkspaceResolver({db:f.db,workbench:f.workbench,policies:f.policies,workspace:f.manager});
 return {...f,grant,admission,claimed,lease,resolver};
}


/** Real original isolated IO -> inspection -> proposal -> review -> native completion -> finalization. */
export async function completedWorkFixture(t,{finalize=true,rewrite=false,outputPath='source.md',nativeLifecycle}={}){
 const f=await fixture(t,{planPath:outputPath}),runtime=createNativeWorkRuntime({db:f.db,workbench:f.workbench,root:join(f.root,'grant-snapshots'),executionReady:true,budgetPolicy:f.budget});
 configureTaskOutputReader(f.db,input=>readIsolatedTaskFileVersion(f.db,input.source));
 configureTaskOutputDelivery(f.db,new ArtifactService(f.db,join(f.root,'review-artifacts')),f.events);
 const app=Fastify();t.after(()=>app.close());app.setErrorHandler((e,q,r)=>r.status(400).send({error:e.message}));
 const tasks=new PersistentTaskService(f.db,f.workbench,{modelBudgetPolicy:f.budget,discoveryWorkOperations:runtime});
 registerWorkbenchExecution(app,f.db,f.workbench,tasks,'test-source-11df6d',f.budget.ledger,undefined,undefined,runtime);
 const original={run_id:f.admission.run_id,session_ref:'work-test-session',execution_lease:f.lease};
 const post=(path,payload)=>app.inject({method:'POST',url:'/internal/v1/workbench/'+path,headers:{authorization:'Bearer test-source-11df6d'},payload:{...original,...payload}});
 const tool=(operation,args,call_id)=>post('tool',{operation,arguments:args,call_id});
 let write=await tool('files.write',{path:outputPath,content:'Exact reviewed work content',expected_version:0},'source-original-write');assert.equal(write.statusCode,200,write.body);
 if(rewrite){write=await tool('files.write',{path:outputPath,content:'Second exact reviewed content',expected_version:1},'source-second-write');assert.equal(write.statusCode,200,write.body);}
 for(const step of tasks.subtasks('owner',f.admission.task_id).items){const response=await tool('tasks.upsert',{subtask_id:step.subtask_id,expected_version:step.version,status:'completed',evidence:[write.json().execution_receipt]},'source-complete-'+step.subtask_id);assert.equal(response.statusCode,200,response.body);}
 const native=await nativeLifecycle?.(f),goalId=native?.goal_id??'source-goal';
 assert.equal((await post('goal-binding',{action:'save',goal_id:goalId,goal_revision:1})).statusCode,200);
 const proposal=await post('goal-proposal',{call_id:'source-complete-proposal',goal_id:goalId,goal_revision:1,intent:'complete',summary:'Review exact work content',files:[{path:outputPath}]});assert.equal(proposal.statusCode,200,proposal.body);
 const paused=native?await native.pause():undefined;
 assert.equal((await post('goal-binding',{action:'save',goal_id:goalId,goal_revision:2})).statusCode,200);
 const checkpoint=paused?.checkpoint??{session_ref:'work-test-session',seq_exclusive:3,turn_end_seq:2,goal_id:goalId,goal_revision:2,log_sha256:'a'.repeat(64)};
 f.coordinator.recordCheckpoint(f.claimed,'work-test-session',checkpoint);
 f.coordinator.waitForTask(f.claimed,{goal_id:goalId,goal_revision:2,phase:'paused',turn_end_seq:checkpoint.turn_end_seq},'SESSION_GOAL_WAITING_APPROVAL',{text:'Owner-reviewed exact work result'});
 const interactions=new InteractionService(f.db,f.events,new TaskWaitResponder(f.db,f.workbench,new RunCommandService(f.db))),card=interactions.list(f.admission.conversation_id,'owner').items[0];assert.ok(card);
 const accept=()=>interactions.respond(card.interaction_id,'owner',{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))},'source-owner-review');
 const prepareCompletion=()=>{accept();const before=paused?.boundary??{host_status:'idle',goal:{goal_id:goalId,goal_revision:2,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}};return withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'owner',f.admission.run_id,before));};
 const finish=(intent,proof)=>{withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'owner',f.admission.run_id,intent.intent_id,proof));return f.coordinator.finalizeReviewedTask('owner',f.admission.run_id,intent.intent_id)};
 const complete=native?async()=>{const intent=prepareCompletion();return finish(intent,await native.complete())}:()=>{const intent=prepareCompletion();return finish(intent,{host_status:'idle',goal:{goal_id:goalId,goal_revision:3,phase:'complete',activation:'disarmed',rounds_started:1,max_goal_rounds:1},checkpoint:{session_ref:'work-test-session',seq_exclusive:4,turn_end_seq:2,goal_id:goalId,goal_revision:3,log_sha256:'b'.repeat(64)}})};
 const finalization=finalize?await complete():undefined;return {...f,runtime,card,finalization,complete,write:write.json()};
}
