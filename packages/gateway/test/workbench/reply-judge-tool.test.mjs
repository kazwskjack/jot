import test from 'node:test';import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';import {TaskReplyPolicies} from '../../src/persistent-tasks/reply-policy.ts';import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
const route={provider:'fixture',model:'judge',revision:'v1',context_window:16000,max_output_tokens:2000,rates:{input:1,output:2,cache_read:1,cache_write:1}};
async function fixture(t,mode='bounded_auto_reply',preflight=()=>{},cachePolicy){
 let calls=0,f;
 let judge={route:{provider:'fixture',model:'judge'},preflight,invoke:async request=>{calls++;assert.equal(f.db.isTransaction,false);assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'in_flight');return {value:{topic_matches:true,tone_matches:true,evidence_supported:true,forbidden_clear:true,risk:'low',requires_user_confirmation:false,claims:[{reply_start:0,reply_end:request.text.length,reference:request.sources[0].reference,quote:'Release available.'}]},usage:{inputTokens:80,outputTokens:20,totalTokens:100}};}};
 if(cachePolicy){
  const {createReplyJudgeClient}=await import('../../src/persistent-tasks/reply-judge-client.ts');
  judge=createReplyJudgeClient({provider:'fixture',model:'judge',base_url:'http://127.0.0.1:18000/v1',api_key_file:'test-key-file',max_input_bytes:8000,timeout_ms:5000,cache_write_policy:cachePolicy},[route],{
   readSecret:()=> 'test-provider-key',fetch:async(_url,init)=>{
    calls++;assert.equal(f.db.isTransaction,false);assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'in_flight');
    const input=JSON.parse(JSON.parse(init.body).messages[1].content);
    const assessment={topic_matches:true,tone_matches:true,evidence_supported:true,forbidden_clear:true,risk:'low',requires_user_confirmation:false,claims:[{reply_start:0,reply_end:input.text.length,reference:input.sources[0].reference,quote:'Release available.'}]};
    return Response.json({model:'judge',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(assessment)}}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:20}}});
   }});
 }
 f=await buildServer({databasePath:':memory:',workspaces:['shared'],workbenchRoot:'.test-tmp/reply-judge-tool',internalChannelToken:'test-judge-internal',modelBudgetRoutes:[route],replyJudge:judge});t.after(async()=>{await f.app.close();f.db.close();});
 const agent=f.workbench.createAgent('alice',{name:'Reader',workspace_id:'shared'}),target=f.conversations.create('alice',{workspace_id:'shared',model:{provider:'harness',model:'automatic'}}),task=f.persistentTasks.create('alice',{agent_id:agent.agent_id,title:'Notes',objective:'Read',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 new TaskReplyPolicies(f.db).update('alice',task.task_id,{expected_version:0,policy:{mode,target:{kind:'conversation',conversation_id:target.conversation_id},direction:{topic:'Release notes',tone:'Brief',evidence_required:true,forbidden:[]},limits:{max_per_24_hours:2,min_interval_seconds:60,expires_at:new Date(Date.now()+86400000).toISOString()},quiet_hours:null}});
 const occurrence=f.persistentTasks.runNow('alice',task.task_id,'test-judge-run'),proof=new TaskExecutionEvidence(f.db).record(occurrence.run_id,'test-judge-proof','web.read',{text:'Release available.'}),scope=f.modelBudgets.createScope('alice','test-judge-budget',{tokens:32000,nano_usd:64000,model_calls:2});f.modelBudgets.bindRun('alice',occurrence.run_id,[scope.scope_id]);
 const coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimNext('test-judge-worker',30000);assert.ok(lease);coordinator.start(lease);const now=new Date().toISOString();f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(occurrence.conversation_id,'alice','test-judge-session',now,now);
 const invoke=(args={text:'Release available.',evidence:[proof]})=>f.app.inject({method:'POST',url:'/internal/v1/workbench/tool',headers:{authorization:'Bearer test-judge-internal'},payload:{run_id:occurrence.run_id,session_ref:'test-judge-session',operation:'tasks.reply_draft',arguments:args,call_id:'test-judge-draft'}});
 return {...f,invoke,getCalls:()=>calls,scope,occurrence};
}
test('existing authenticated reply_draft operation waits outside its transaction for one budgeted host assessment',async t=>{
 const f=await fixture(t),response=await f.invoke();assert.equal(response.statusCode,200,response.body);assert.equal(response.json().reply_check.verdict,'eligible');assert.equal(f.getCalls(),1);
 const replay=await f.invoke();assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),response.json());assert.equal(f.getCalls(),1);assert.equal(f.modelBudgets.balance('alice',f.scope.scope_id).used.model_calls,'1');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);
 const forged=await f.invoke({text:'Release available.',evidence:[],model:'attacker'});assert.equal(forged.statusCode,403);assert.equal(f.getCalls(),1);
});
test('equivalent cache client settles the original authenticated draft once and persists its accounting without sending',async t=>{
 const f=await fixture(t,'bounded_auto_reply',()=>{},'input-rate-equivalent');
 const response=await f.invoke();assert.equal(response.statusCode,200,response.body);assert.equal(response.json().reply_check.verdict,'eligible');
 const replay=await f.invoke();assert.deepEqual(replay.json(),response.json());assert.equal(f.getCalls(),1);
 const balance=f.modelBudgets.balance('alice',f.scope.scope_id);assert.deepEqual(balance.used,{tokens:'120',nano_usd:'140',model_calls:'1'});assert.equal(balance.held.model_calls,'0');
 const captured=JSON.parse(f.db.prepare('SELECT response_json FROM wb_task_reply_semantic_responses').get().response_json);
 assert.equal(captured.usage.inputTokens,80);assert.equal(captured.usage.cacheReadTokens,20);assert.equal(captured.usage.cacheWriteTokens,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);
});

test('review mode still uses human review and never calls the configured judge',async t=>{
 const f=await fixture(t,'review'),response=await f.invoke();assert.equal(response.statusCode,200,response.body);assert.equal(response.json().review.kind,'approval');assert.equal(response.json().reply_check,undefined);assert.equal(f.getCalls(),0);
});
test('a context-bound failure preserves the original draft and returns unavailable without allocating a model call',async t=>{
 const f=await fixture(t,'bounded_auto_reply',()=>{throw new Error('reply_judge_input_too_large');});const response=await f.invoke();assert.equal(response.statusCode,200,response.body);assert.equal(response.json().reply_check.verdict,'unavailable');assert.equal(f.getCalls(),0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_drafts').get().n,1);
});
