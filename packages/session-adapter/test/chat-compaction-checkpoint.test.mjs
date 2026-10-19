import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const impl=await import('../chat-compaction-checkpoint.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const hash=value=>createHash('sha256').update(JSON.stringify(value,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)).digest('hex');
function fixture(){
 const source={run_id:'run-a',context_sha256:'a'.repeat(64),model:{provider:'fixture',model:'fast'}},message=(id,kind)=>({id,role:'user',source:{kind,...(kind==='jot-chat-context'?{run_id:'run-a',context_sha256:source.context_sha256}:{rpcId:'run-a'})},content:[{type:'text',text:'Synthetic context.'}]}),header={id:'session-a',agentPreset:'jot-chat'};
 const events=Array.from({length:8},(_,seq)=>({seq,type:'turn/start',data:{}}));events[0]={seq:0,type:'system/message',data:{}};events[1]={seq:1,type:'user/message',data:message('context-a','jot-chat-context')};events[2]={seq:2,type:'user/message',data:message('native-a','user')};events[5]={seq:5,type:'assistant/message',data:{}};
 const before={header,inheritedEventCount:0,events:structuredClone(events),surface_nodes:[0,1,2,5],surface_generation:1},proof={raw_event_count:8,raw_sha256:hash({header,inheritedEventCount:0,events}),native_message_ids:['native-a'],answer_seq:5,profile_fingerprint:'b'.repeat(64)},summary=[{type:'text',text:'SYNTHETIC-CHECKPOINT'}],result={compactionId:'compact-a',sourceCommandId:'attempt-a',startSeq:8,summarySeq:9,endSeq:11,summary,shadowedRange:{start:1,end:5},shadowedSeqs:[1,2,5],shadowedTokenCount:1000};
 const lifecycle={compactionId:'compact-a',sourceCommandId:'attempt-a',turn:null};events.push({seq:8,type:'compaction/start',data:{...lifecycle}},{seq:9,type:'compaction/summary',data:{compactionId:'compact-a',sourceCommandId:'attempt-a',summary,shadowedRange:result.shadowedRange,shadowedSeqs:result.shadowedSeqs,shadowedTokenCount:1000,provider:'fixture',model:'fast',usage:{inputTokens:10,outputTokens:1,totalTokens:11},llmStreamCall:true}},{seq:10,type:'user/message',data:{id:'checkpoint-a',role:'user',source:{kind:'compact-checkpoint',compactionId:'compact-a',sourceCommandId:'attempt-a'},content:[{type:'text',text:'Framed SYNTHETIC-CHECKPOINT'}]},surfaceOp:{op:'replace',startSeq:1,endSeq:5},sourceEventSeqs:[8,9,1,2,5]},{seq:11,type:'compaction/end',data:{...lifecycle}});
 const agent={id:'session-a',session:{id:'session-a',header,inheritedEventCount:0,seq:12,surface:{nodes:[0,10],replaceGeneration:2},snapshotEvents:()=>structuredClone(events)}};return{source,before,proof,result,agent,events,attempt_id:'attempt-a'};
}
test('native checkpoint evidence binds the unchanged prefix, original messages, official adjacent replacement and generation',()=>{
 assert.equal(typeof impl.readNativeChatCheckpoint,'function');const f=fixture(),value=impl.readNativeChatCheckpoint(f);assert.equal(value.summary_text,'SYNTHETIC-CHECKPOINT');assert.equal(value.witness.prefix_raw_sha256,f.proof.raw_sha256);assert.equal(value.witness.surface_generation_after,2);assert.equal(value.witness.summary_seq+1,value.witness.replacement_seq);assert.ok(JSON.stringify(value).length<3500);
});
test('partial, changed, unrelated or oversized native summaries cannot publish a useful checkpoint',()=>{
 assert.equal(typeof impl.readNativeChatCheckpoint,'function');
 for(const mode of ['prefix','generation','end','selected','context','source','replacement','text','large']){const f=fixture();if(mode==='prefix')f.events[2].data.content[0].text+=' changed';if(mode==='generation')f.agent.session.surface.replaceGeneration=1;if(mode==='end')f.events[11].data.error={message:'cancelled'};if(mode==='selected')f.result.shadowedSeqs=[1,5];if(mode==='context')f.events[1].data.source.context_sha256='c'.repeat(64);if(mode==='source')f.events[8].data.sourceCommandId='foreign';if(mode==='replacement')f.events[10].sourceEventSeqs=[];if(mode==='text')f.events[9].data.summary=[{type:'image'}];if(mode==='large')f.events[9].data.summary=[{type:'text',text:'x'.repeat(6001)}];assert.throws(()=>impl.readNativeChatCheckpoint(f),undefined,mode);}
});

function replacedSurfaceFixture(coverAnswer=true){
 const f=fixture(),context=structuredClone(f.events[1].data);context.id='replaced-context';
 f.events.splice(8,0,{seq:8,type:'user/message',data:context,surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1]});
 for(let i=9;i<f.events.length;i++)f.events[i].seq=i;
 const selected=coverAnswer?[8,2,5]:[8,2],range={start:8,end:selected.at(-1)};
 Object.assign(f.result,{startSeq:9,summarySeq:10,endSeq:12,shadowedRange:range,shadowedSeqs:selected});
 Object.assign(f.events[10].data,{shadowedRange:range,shadowedSeqs:selected});
 Object.assign(f.events[11],{surfaceOp:{op:'replace',startSeq:range.start,endSeq:range.end},sourceEventSeqs:[9,10,...selected]});
 Object.assign(f.before,{events:structuredClone(f.events.slice(0,9)),surface_nodes:[0,8,2,5],surface_generation:2});
 Object.assign(f.proof,{raw_event_count:9,raw_sha256:hash({header:f.before.header,inheritedEventCount:0,events:f.before.events})});
 Object.assign(f.agent.session,{seq:13,surface:{nodes:coverAnswer?[0,11]:[0,11,5],replaceGeneration:3}});return f;
}

test('checkpoint selection follows native surface positions after an earlier replacement, including a retained answer',()=>{
 for(const coverAnswer of [true,false]){const f=replacedSurfaceFixture(coverAnswer),{witness:w}=impl.readNativeChatCheckpoint(f);
  assert.equal(w.protocol,2);assert.ok(w.shadowed_start>w.shadowed_end);assert.equal(w.surface_node_count,4);assert.equal(w.shadowed_start_position,1);assert.equal(w.shadowed_end_position,coverAnswer?3:2);assert.equal(w.context_marker_position,1);assert.equal(w.answer_position,3);assert.equal(w.answer_covered,coverAnswer);
 }
 for(const mode of ['duplicate','order','replacement']){const f=replacedSurfaceFixture();if(mode==='duplicate')f.result.shadowedSeqs=[8,2,2,5];if(mode==='order')f.before.surface_nodes=[0,8,5,2];if(mode==='replacement')f.events[11].surfaceOp.endSeq=8;assert.throws(()=>impl.readNativeChatCheckpoint(f),undefined,mode);}
});
