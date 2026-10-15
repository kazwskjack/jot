import test from 'node:test';import assert from 'node:assert/strict';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
import {createNativeInvariantReplay} from '../native-invariant-replay.js';
test('official session invariant cold replay accepts its tool exception and rejects malformed step relations without an Agent',{skip:!process.env.JOT_DSH_RUNTIME_MODULES},async()=>{
 const root=resolve(process.env.JOT_DSH_RUNTIME_MODULES),load=name=>import(pathToFileURL(join(root,name,'lib/index.js')).href),cordis=await load('cordis'),invariants=await load('dsh-invariants'),sessionInvariant=await import(pathToFileURL(join(root,'dsh-session/lib/invariant.js')).href);
 const verify=createNativeInvariantReplay({Context:cordis.Context,Service:cordis.Service,InvariantRegistry:invariants.InvariantRegistry,sessionInvariant});
 const begin=[{type:'turn/start',data:{turn:1}},{type:'step/start',data:{turn:1,step:1}}],end=[{type:'step/end',data:{turn:1,step:1}},{type:'turn/end',data:{turn:1}}];
 const view=history=>{const events=history.map((event,seq)=>({seq,surfaceOp:'append',...event}));return Object.freeze({id:'closed-child',header:{id:'closed-child',parentSession:'lead',isSeeded:false},inheritedEventCount:0,seq:events.length,snapshotEvents:()=>events});};
 assert.deepEqual(await verify(view([...begin,...end])),{validated:true});
 assert.deepEqual(await verify(view([...begin,{type:'tool/result',data:{turn:1,step:1,message:{isError:true,source:{callId:'not-started'}},error:{code:'TOOL_NOT_STARTED'}}},...end])),{validated:true});
 assert.deepEqual(await verify(view([...begin,{type:'tool/call',data:{turn:1,step:1,callId:'cleared-on-step-end'}},...end])),{validated:true});
 await assert.rejects(verify(view([...begin,{type:'turn/end',data:{turn:1}}])));
 await assert.rejects(verify(view([...begin,{type:'tool/result',data:{turn:1,step:1,message:{source:{callId:'unknown'}}}},...end])));
});
