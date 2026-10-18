import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openProductDatabase} from '../../src/db/database.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {HarnessWorker} from '../../src/harness/worker.ts';
import {OfficialSessionRunner} from '../../src/harness/official-session-runner.ts';
import {inspectOrdinaryExecutionPolicy} from '../../src/conversations/execution-policy.ts';
const hash=text=>createHash('sha256').update(text).digest('hex');
const chat={protocol:1,mode:'chat',model:{provider:'local-scripted',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-v1',context_revision:'bounded-v1'};
function fixture(t){
 const db=openProductDatabase(':memory:');t.after(()=>db.close());const events=new EventStore(db),runs=new RunRepository(db,events),conversations=new ConversationRepository(db);
 const c=conversations.create('owner',{workspace_id:'ws',title:'Synthetic mode execution',model:{provider:'local-scripted',model:'work',reasoning_effort:'high'},mode:'chat'},{chatPolicy:chat});
 const source=runs.enqueue(c.conversation_id,'owner',{client_message_id:'original',content:[{type:'text',text:'Synthetic question'}]},{modePolicy:chat});
 const row=db.prepare('SELECT * FROM ga_runs WHERE id=?').get(source.run_id),policy=JSON.parse(row.execution_policy_json);
 return{db,events,runs,c,source,row,policy,coordinator:new HarnessCoordinator(db,runs,events)};
}

test('a Worker without the mode protocol refuses Chat without falling through to Work',async t=>{
 const f=fixture(t);let calls=0;
 const runner={ordinaryCompletionProtocol:1,run:async()=>{calls++;throw Error('no Work fallback');}};
 const worker=new HarnessWorker(f.db,f.coordinator,runner,{workerId:'legacy-mode-worker',leaseMs:30000,ordinaryInputRecoveryEnabled:true,ordinarySteeringEnabled:true});
 await worker.processNext();assert.equal(calls,0);assert.equal(f.runs.get(f.source.run_id,'owner').error_code,'CONVERSATION_MODE_UNAVAILABLE');
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
});

test('original Chat policy, Session and final answer survive current conversation mode movement',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE ga_conversations SET mode='work' WHERE id=?").run(f.c.conversation_id);let calls=0;
 const runner={conversationModeProtocol:1,ordinaryCompletionProtocol:1,run:async input=>{
  calls++;assert.deepEqual(input.conversationPolicy,f.policy);assert.equal(input.sessionRef,f.row.native_session_ref);input.onReady();
  const scope=input.originalAdmission.executionLease,read=inspectOrdinaryExecutionPolicy(f.db,f.source.run_id,input.sessionRef,scope);assert.equal(read.policy.mode,'chat');assert.equal(read.execution_authorized,false);
  assert.throws(()=>inspectOrdinaryExecutionPolicy(f.db,f.source.run_id,'other-session',scope));
  const text='Synthetic scoped Chat answer',candidate={observed:true,completed:true,runtime_status:'not_required',reason_code:'SESSION_TURN_COMPLETED',final_text:text};
  const proof={protocol:1,status:'complete',run_id:f.source.run_id,session_id:input.sessionRef,execution_lease:scope,input_sha256:hash(f.db.prepare('SELECT content_json FROM ga_messages WHERE id=?').get(f.source.message_id).content_json),command_ids:[],native_message_ids:['original-native'],answer_sha256:hash(text),answer_seq:2,turn_end_seq:3,snapshot_seq:4,execution_authorized:false};
  assert.equal(await input.ordinaryCompletion.publish(candidate,proof,new AbortController().signal),true);return candidate;
 }};
 const worker=new HarnessWorker(f.db,f.coordinator,runner,{workerId:'chat-mode-worker',leaseMs:30000,ordinaryInputRecoveryEnabled:true,ordinarySteeringEnabled:true});
 await worker.processNext();assert.equal(calls,1);assert.equal(f.runs.get(f.source.run_id,'owner').status,'succeeded');
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);assert.equal(await worker.processNext(),null);
});

test('the official Runner targets the accepted Chat preset only with explicit configuration and original admission',async t=>{
 const f=fixture(t),calls=[];
 const client={create:async(...args)=>{calls.push(['create',args[2]]);return{};},prompt:async()=>({accepted:true}),async *follow(){yield{type:'snapshot',cursor:0,records:[]};yield{type:'event',event:{seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:'Synthetic native response'}]}}}};yield{type:'event',event:{seq:2,type:'turn/end',data:{reason:{kind:'completed'}}}};}};
 const input={enabled:true,taskRequestId:f.source.run_id,sessionRef:f.row.native_session_ref,message:'Synthetic question',deferCompletionProbe:true,conversationPolicy:f.policy,originalAdmission:{executionLease:{owner:'worker',generation:1}}};
 await assert.rejects(()=>new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'}).run(input),/conversation_mode_unavailable/);assert.equal(calls.length,0);
 const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general',chatAgentPreset:'jot-chat'});
 await assert.rejects(()=>runner.run({...input,originalAdmission:undefined}),/ordinary_input_admission_invalid|conversation_mode_unavailable/);assert.equal(calls.length,0);
 const result=await runner.run(input);assert.equal(result.final_text,'Synthetic native response');assert.deepEqual(calls,[['create','jot-chat']]);
});
