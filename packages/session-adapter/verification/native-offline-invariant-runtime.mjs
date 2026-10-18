import test from 'node:test';import assert from 'node:assert/strict';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
import {createNativeInvariantReplay} from '../native-invariant-replay.js';
test('detached SDK replay retains official tool exceptions and rejects malformed full-prefix relations without an Agent',{skip:!process.env.JOT_DSH_RUNTIME_MODULES},async()=>{
 const root=resolve(process.env.JOT_DSH_RUNTIME_MODULES),load=name=>import(pathToFileURL(join(root,name,'lib/index.js')).href),{Session}=await load('dsh-session'),llm=await load('dsh-llm');
 const verify=createNativeInvariantReplay({Session});
 const begin=[{type:'turn/start',data:{turn:1}},{type:'step/start',data:{turn:1,step:1}}],end=[{type:'step/end',data:{turn:1,step:1}},{type:'turn/end',data:{turn:1}}];
 const view=history=>{const events=history.map((event,seq)=>({seq,time:0,...event}));return Object.freeze({id:'closed-child',header:{version:4,id:'closed-child',createdAt:0,parentSession:'lead',isSeeded:false},inheritedEventCount:0,seq:events.length,snapshotEvents:()=>events});};
 const result=(callId,notStarted=false)=>({type:'tool/result',surfaceOp:'append',data:{turn:1,step:1,message:llm.createToolResultMessage({callId,content:[],isError:notStarted}),...(notStarted?{error:{code:'TOOL_NOT_STARTED'}}:{})}});
 assert.deepEqual(await verify(view([...begin,...end])),{validated:true});
 assert.deepEqual(await verify(view([...begin,result('not-started',true),...end])),{validated:true});
 assert.deepEqual(await verify(view([...begin,{type:'tool/call',data:{turn:1,step:1,callId:'cleared-on-step-end'}},...end])),{validated:true});
 for(const history of [[...begin,{type:'turn/end',data:{turn:1}}],[...begin,result('unknown'),...end],[{type:'turn/start',data:{turn:2}}],[{type:'request/context',data:{}}],[...begin,{type:'step/end',data:{turn:1,step:2}}]]){
  const candidate=view(history);assert.doesNotThrow(()=>Session.create(candidate.id,candidate.snapshotEvents(),candidate.header,0));await assert.rejects(verify(candidate));
 }
 const gap=view([...begin,...end]);gap.snapshotEvents()[1].seq=7;await assert.rejects(verify(gap));
 const invalidSurface=view([...begin,...end]);invalidSurface.snapshotEvents()[0].surfaceOp='append';await assert.rejects(verify(invalidSurface));
 const valid=view([...begin,...end]),before=JSON.stringify(valid.snapshotEvents());await verify(valid);assert.equal(JSON.stringify(valid.snapshotEvents()),before);
 await assert.rejects(verify({...valid,seq:valid.seq+1}));
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(verify(valid,{signal:cancelled.signal}));
});
