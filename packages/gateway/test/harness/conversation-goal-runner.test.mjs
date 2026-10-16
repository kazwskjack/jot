import test from 'node:test';
import assert from 'node:assert/strict';
import {OfficialSessionRunner} from '../../src/harness/official-session-runner.ts';
test('ordinary conversation follows native Goal rounds on the same stream until paused',async()=>{
 let reads=0,prompts=0,follows=0;
 const client={create:async()=>({}),prompt:async()=>{prompts++;return{}},conversationGoal:async()=>({goal:{id:'native-goal',revision:reads+1,objective:'Finish task',phase:++reads===1?'active':'paused',activation:reads===1?'armed':'disarmed'}}),async *follow(){
  follows++;yield {type:'snapshot',cursor:0,records:[]};
  for(let n=1;n<=2;n++){
   yield {type:'event',event:{type:'assistant/message',seq:n*2-1,data:{message:{content:[{type:'text',text:`round${n}`}]}}}};
   yield {type:'event',event:{type:'turn/end',seq:n*2,data:{reason:{kind:'completed'}}}};
  }
 }};
 const result=await new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'}).run({enabled:true,taskRequestId:'req',message:'goal',sessionRef:'s',deferCompletionProbe:true});
 assert.equal(reads,2);assert.equal(prompts,1);assert.equal(follows,1);assert.equal(result.final_text,'round2');
});

test('budgeted role chat does not probe the ordinary conversation Goal endpoint after completion',async()=>{
 let probes=0,prompts=0;
 const client={create:async()=>({}),prompt:async()=>{prompts++;return{};},conversationGoal:async()=>{probes++;throw new Error('conversation_goal_scope_invalid');},async *follow(){
  yield {type:'snapshot',cursor:0,records:[]};yield {type:'event',event:{type:'assistant/message',seq:1,data:{message:{content:[{type:'text',text:'Role answer'}]}}}};yield {type:'event',event:{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}};
 }};
 const result=await new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general',workbenchAgentPreset:'jot-workbench-budgeted'}).run({enabled:true,taskRequestId:'role-run',message:'Role chat',sessionRef:'role-session',workbenchRunId:'role-run',workbenchExecutionLease:{owner:'worker',generation:1},workbenchBudgetEnforced:true,deferCompletionProbe:true});
 assert.equal(result.completed,true);assert.equal(result.final_text,'Role answer');assert.equal(probes,0);assert.equal(prompts,1);
});


test('paused or blocked ordinary Goals do not re-prompt pending crawl work',async()=>{
 for(const phase of ['paused','blocked']){
  let prompts=0;const client={create:async()=>({}),prompt:async()=>{prompts++;return{};},conversationGoal:async()=>({goal:{id:'native',revision:2,objective:'Work',phase,activation:'disarmed'}}),async *follow(){
   yield{type:'snapshot',cursor:0,records:[]};yield{type:'event',event:{type:'tool/result',seq:1,data:{batch_id:'batch-fixture-12345678',status:'pending',terminal:false}}};yield{type:'event',event:{type:'assistant/message',seq:2,data:{message:{content:[{type:'text',text:'Waiting for the user'}]}}}};yield{type:'event',event:{type:'turn/end',seq:3,data:{reason:{kind:'completed'}}}};
  }};
  await new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general',maxCrawlAutoContinues:2}).run({enabled:true,taskRequestId:'paused-run',message:'Work',sessionRef:'paused-session',deferCompletionProbe:true});assert.equal(prompts,1,phase);
 }
});
test('an ended active Goal stream cannot manufacture completion or another prompt',async()=>{
 let prompts=0;const client={create:async()=>({}),prompt:async()=>{prompts++;return{};},conversationGoal:async()=>({goal:{id:'native',revision:1,objective:'Work',phase:'active',activation:'armed'}}),async *follow(){yield{type:'snapshot',cursor:0,records:[]};yield{type:'event',event:{type:'assistant/message',seq:1,data:{message:{content:[{type:'text',text:'Partial'}]}}}};yield{type:'event',event:{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}};}};
 const result=await new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'}).run({enabled:true,taskRequestId:'ended-run',message:'Work',sessionRef:'ended-session',deferCompletionProbe:true});assert.equal(result.completed,false);assert.equal(result.reason_code,'SESSION_GOAL_STREAM_ENDED');assert.equal(prompts,1);
});

