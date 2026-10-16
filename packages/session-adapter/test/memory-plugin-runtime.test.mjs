import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runMemoryPluginExtraction} from '../memory-plugin-runtime.js';
const installed=process.env.JOT_DSH_RUNTIME_MODULES;
async function setup(t){
 const runtime={...(await import(pathToFileURL(join(installed,'cordis/lib/index.js')).href)),...(await import(pathToFileURL(join(installed,'dsh-llm/lib/index.js')).href)),plugin:await import(pathToFileURL(join(installed,'../@dsh-external/dsh-memory/lib/index.js')).href)};
 const base=resolve('.test-tmp/plugin-extraction');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
 return {runtime,root,binding:{runId:'run-extraction',sessionRef:'session-extraction'},packet:{capture_id:'capture-a',version:2,status:'ready',policy_current:true,sources:[{source_id:'source-a',origin:'human',available:true,text:'Use short answers.'}]},route:{provider:'scripted',model:'scripted'},signal:t.signal,authorize:async()=>{}};
}
test('isolated upstream plugin extracts once through the authorized high stream and proposes without extra injection',{skip:!installed,timeout:15000},async t=>{
 const runtime={...(await import(pathToFileURL(join(installed,'cordis/lib/index.js')).href)),...(await import(pathToFileURL(join(installed,'dsh-llm/lib/index.js')).href)),plugin:await import(pathToFileURL(join(installed,'../@dsh-external/dsh-memory/lib/index.js')).href)};
 const base=resolve('.test-tmp/plugin-extraction');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
 let calls=0,checks=0,proposal;const binding={runId:'run-extraction',sessionRef:'session-extraction'},packet={capture_id:'capture-a',version:2,status:'ready',policy_current:true,sources:[{source_id:'source-a',origin:'human',available:true,text:'I prefer short answers with references.'}]};
 const result=await runMemoryPluginExtraction({runtime,root,binding,packet,signal:t.signal,route:{provider:'scripted',model:'scripted'},authorize:async()=>{checks++;},stream:async function*(options){calls++;assert.equal(options.sessionId,binding.sessionRef);assert.equal(options.reasoningEffort,'high');assert.match(JSON.stringify(options.messages),/source-a/);assert.equal(options.tools,undefined);yield {type:'text-delta',index:0,text:JSON.stringify({summary:'Response preference',notes:[{content:'Prefers short answers with references.',source_ids:['source-a']}]})};yield {type:'usage',usage:{inputTokens:10,outputTokens:10,totalTokens:20}};yield {type:'finish',reason:{kind:'stop'}};},propose:async input=>{proposal=input;return {capture_id:packet.capture_id,version:3,status:'proposed'};}});
 assert.equal(calls,1);assert.ok(checks>=2);assert.equal(result.status,'proposed');assert.equal(proposal.expected_version,2);assert.equal(proposal.notes[0].source_ids[0],'source-a');
 await assert.rejects(runMemoryPluginExtraction({runtime,root,binding,packet,signal:t.signal,route:{provider:'scripted',model:'scripted'},authorize:async()=>{},stream:async function*(){throw Error('must not retry');},propose:async()=>{throw Error('must not propose');}}),/memory_extraction_claimed/);
});

test('upstream output with invented sources or verification fields cannot become a candidate',{skip:!installed,timeout:15000},async t=>{
 for(const note of [{content:'Invented',source_ids:['other-source']},{content:'Self verified',source_ids:['source-a'],verified:true}]){
  const f=await setup(t);let proposals=0;await assert.rejects(runMemoryPluginExtraction({...f,stream:async function*(){yield {type:'text-delta',index:0,text:JSON.stringify({summary:'Invalid',notes:[note]})};yield {type:'finish',reason:{kind:'stop'}};},propose:async()=>{proposals++;}}),/memory_extraction_invalid_output/);assert.equal(proposals,0);
 }
});

test('revocation and cancellation prevent both model calls and proposal publication',{skip:!installed,timeout:15000},async t=>{
 const f=await setup(t);let calls=0,proposals=0;const stream=async function*(){calls++;},propose=async()=>{proposals++;};
 await assert.rejects(runMemoryPluginExtraction({...f,authorize:async()=>{throw Error('revoked');},stream,propose}),/revoked/);
 const controller=new AbortController();controller.abort(Error('user_cancelled'));await assert.rejects(runMemoryPluginExtraction({...f,signal:controller.signal,stream,propose}),/user_cancelled/);assert.equal(calls,0);assert.equal(proposals,0);
});

test('empty durable result is explicit and an unconfirmed proposal receipt is not success',{skip:!installed,timeout:15000},async t=>{
 const f=await setup(t);await assert.rejects(runMemoryPluginExtraction({...f,stream:async function*(){yield {type:'text-delta',index:0,text:JSON.stringify({summary:'Nothing durable',notes:[]})};yield {type:'finish',reason:{kind:'stop'}};},propose:async input=>{assert.deepEqual(input.notes,[]);return {status:'pending'};}}),/memory_extraction_proposal_receipt_invalid/);
});


test('mid-stream cancellation aborts the original stream and cannot publish partial facts',{skip:!installed,timeout:15000},async t=>{
 const f=await setup(t),controller=new AbortController();let proposals=0,calls=0,observedAbort=false;
 await assert.rejects(runMemoryPluginExtraction({...f,signal:controller.signal,stream:async function*(options){calls++;yield {type:'text-delta',index:0,text:'{"summary":"partial"'};controller.abort(Error('user_cancelled_mid_stream'));observedAbort=options.signal.aborted;yield {type:'finish',reason:{kind:'stop'}};},propose:async()=>{proposals++;}}),/user_cancelled_mid_stream/);
 assert.equal(calls,1);assert.equal(observedAbort,true);assert.equal(proposals,0);
});

test('source revocation after model completion prevents candidate publication',{skip:!installed,timeout:15000},async t=>{
 const f=await setup(t);let revoked=false,proposals=0;
 await assert.rejects(runMemoryPluginExtraction({...f,authorize:async()=>{if(revoked)throw Error('source_revoked_after_model');},stream:async function*(){yield {type:'text-delta',index:0,text:JSON.stringify({summary:'Preference',notes:[{content:'Prefers short answers.',source_ids:['source-a']}]})};yield {type:'finish',reason:{kind:'stop'}};revoked=true;},propose:async()=>{proposals++;}}),/source_revoked_after_model/);assert.equal(proposals,0);
});

test('extraction preserves the original route output ceiling rather than the upstream summary default',{skip:!installed,timeout:15000},async t=>{
 const f=await setup(t);let outputLimit;
 const result=await runMemoryPluginExtraction({...f,route:{...f.route,max_output_tokens:16384},stream:async function*(options){outputLimit=options.maxTokens;yield {type:'text-delta',index:0,text:JSON.stringify({summary:'Preference',notes:[{content:'Prefers short answers.',source_ids:['source-a']}]})};yield {type:'finish',reason:{kind:'stop'}};},propose:async()=>({capture_id:f.packet.capture_id,version:3,status:'proposed'})});
 assert.equal(result.status,'proposed');assert.equal(outputLimit,16384);
});
