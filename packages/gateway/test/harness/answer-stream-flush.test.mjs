import test from 'node:test';import assert from 'node:assert/strict';
import {OfficialSessionRunner} from '../../src/harness/official-session-runner.ts';
test('a short native answer delta flushes while the provider is still waiting to finish',async()=>{
 let release,entered;const finish=new Promise(r=>release=r),started=new Promise(r=>entered=r),projected=[];
 const client={create:async()=>({}),prompt:async()=>({}),async *follow(){
  yield{type:'snapshot',cursor:0,records:[],assistantStream:{}};
  yield{type:'assistant-stream',frame:{type:'start',attemptId:'original-attempt',revision:1,turn:1,step:1}};
  yield{type:'assistant-stream',frame:{type:'chunk',attemptId:'original-attempt',index:0,chunk:{type:'text-delta',index:0,text:'Small first chunk'}}};
  entered();await finish;
  yield{type:'event',event:{type:'assistant/message',seq:1,data:{message:{content:[{type:'text',text:'Small first chunk'}]}}}};
  yield{type:'event',event:{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}};
 }};
 const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general',deltaFlushMs:50});
 const pending=runner.run({enabled:true,taskRequestId:'flush-run',sessionRef:'flush-session',message:'Fixture question',deferCompletionProbe:true,onProjection:async e=>projected.push(e)});
 try{await started;await new Promise(r=>setTimeout(r,150));assert.equal(projected.filter(e=>e.type==='assistant.delta'&&e.payload.text==='Small first chunk').length,1);assert.equal(projected.some(e=>e.type==='assistant.settled'),false);}
 finally{release();await pending;}
 assert.equal(projected.filter(e=>e.type==='assistant.delta').length,1);
});

test('timer and size-triggered flushes serialize delayed projections with distinct indexes',async()=>{
 let entered,release;const first=new Promise(r=>entered=r),gate=new Promise(r=>release=r),projected=[];let active=0,peak=0;
 const text='B'.repeat(64),client={create:async()=>({}),prompt:async()=>({}),async *follow(){
  yield{type:'snapshot',cursor:0,records:[],assistantStream:{}};yield{type:'assistant-stream',frame:{type:'start',attemptId:'attempt',revision:1,turn:1,step:1}};
  yield{type:'assistant-stream',frame:{type:'chunk',attemptId:'attempt',index:0,chunk:{type:'text-delta',index:0,text:'A'}}};await first;
  yield{type:'assistant-stream',frame:{type:'chunk',attemptId:'attempt',index:1,chunk:{type:'text-delta',index:0,text}}};
  yield{type:'event',event:{type:'assistant/message',seq:1,data:{message:{content:[{type:'text',text:'A'+text}]}}}};yield{type:'event',event:{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}};
 }};
 const pending=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general',deltaFlushMs:50,deltaMaxChars:32}).run({enabled:true,taskRequestId:'serial-flush',sessionRef:'serial-session',message:'fixture',deferCompletionProbe:true,onProjection:async e=>{active++;peak=Math.max(peak,active);if(e.type==='assistant.delta'&&e.payload.text==='A'){entered();await gate;}projected.push(e);active--;}});
 try{await first;await new Promise(r=>setTimeout(r,80));assert.equal(projected.length,0);assert.equal(peak,1);}finally{release();await pending;}
 const deltas=projected.filter(e=>e.type==='assistant.delta');assert.deepEqual(deltas.map(e=>e.payload.delta_index),[0,1]);assert.equal(deltas.map(e=>e.payload.text).join(''),'A'+text);assert.equal(peak,1);
});

for(const failProjection of [false,true])test(failProjection?'a scheduled projection failure aborts the original follow and cannot settle an answer':'cancellation clears the pending timer without publishing buffered text',async()=>{
 let signal,calls=0;const original=Error('synthetic projection failure');
 const client={create:async(_id,_cwd,_preset,s)=>{signal=s;return{};},prompt:async()=>({}),async *follow(){
  yield{type:'snapshot',cursor:0,records:[],assistantStream:{}};yield{type:'assistant-stream',frame:{type:'start',attemptId:'attempt',revision:1,turn:1,step:1}};yield{type:'assistant-stream',frame:{type:'chunk',attemptId:'attempt',index:0,chunk:{type:'text-delta',index:0,text:'held'}}};
  await new Promise((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 }};
 const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general',deltaFlushMs:50,timeoutMs:failProjection?1000:20});
 await assert.rejects(()=>runner.run({enabled:true,taskRequestId:'cancel-flush',sessionRef:'cancel-session',message:'fixture',deferCompletionProbe:true,onProjection:async()=>{calls++;throw original;}}),e=>failProjection?e===original:e.message==='session_follow_timeout');
 await new Promise(r=>setTimeout(r,80));assert.equal(calls,failProjection?1:0);
});
