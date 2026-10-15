import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {verifyOfflineNativeClosure} from '../native-child-closure.js';
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function fixture(events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'turn/end',data:{}}]){
 const header={parentSession:'parent',delegationDepth:0,isSeeded:false};let opens=0,closes=0;
 const proof={protocol:1,session_ref:'child',parent_session_ref:'parent',seq_exclusive:events.length,turn_end_seq:events.findLastIndex(e=>e.type==='turn/end'),log_sha256:createHash('sha256').update(canonical(header)+'\n'+events.map(e=>canonical(e)+'\n').join('')).digest('hex'),driver_nonresident:true,inbox_pending:0};
 const input={parentSessionRef:'parent',proof,validateLog:async()=>({validated:true}),registry:{get:()=>undefined},sessions:{get:()=>undefined},projections:{snapshot:session=>({asOfSeq:session.seq-1,values:{inbox:{'next-turn':[],'next-step':[]}}})},persistence:{flush:async()=>{},open:async()=>{opens++;return {id:'child',access:'read',header,inheritedEventCount:0,read:async(offset,count)=>({events:events.slice(offset,offset+count)}),close:async()=>{closes++;}};}}};
 return {input,events,header,opens:()=>opens,closes:()=>closes};
}
test('offline closure verifies two exact durable reads without creating or resuming a child',async()=>{const f=fixture();assert.deepEqual(await verifyOfflineNativeClosure(f.input),{verified:true,session_ref:'child',seq_exclusive:2,log_sha256:f.input.proof.log_sha256});assert.equal(f.opens(),2);assert.equal(f.closes(),2);});
test('offline closure refuses changed header, changed content, truncation and any suffix',async()=>{
 for(const alter of [f=>{f.header.parentSession='foreign';},f=>{f.events[0].data.changed=true;},f=>{f.events.pop();},f=>{f.events.push({seq:2,type:'model/selection',data:{}});}]){const f=fixture();alter(f);await assert.rejects(verifyOfflineNativeClosure(f.input));assert.equal(f.closes(),f.opens());}
});
test('a matching digest does not bless unresolved turns, tools or inbox histories',async()=>{
 const histories=[
  [{type:'turn/start',data:{}},{type:'turn/end',data:{}},{type:'turn/start',data:{}}],
  [{type:'turn/start',data:{}},{type:'tool/call',data:{callId:'missing-result'}},{type:'turn/end',data:{}}],
  [{type:'turn/start',data:{}},{type:'tool/result',data:{message:{toolCallId:'missing-call'}}},{type:'turn/end',data:{}}],
  [{type:'turn/start',data:{}},{type:'tool/result',data:{error:{code:'TOOL_OUTCOME_UNKNOWN'}}},{type:'turn/end',data:{}}],
  [{type:'turn/start',data:{}},{type:'turn/end',data:{}},{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'pending'}]}}],
  [{type:'turn/start',data:{}},{type:'turn/end',data:{}},{type:'agent/inbox/spliced',data:{target:'next-step',start:1,removedCount:0,inserted:[]}}],
  [{type:'turn/start',data:{}},{type:'turn/end',data:{}},{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'same'},{id:'same'}]}},{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:2,inserted:[]}}]
 ];for(const history of histories){const f=fixture(history.map((event,seq)=>({seq,...event})));await assert.rejects(verifyOfflineNativeClosure(f.input));assert.equal(f.closes(),f.opens());}
});
test('offline inbox fold accepts an actually consumed original message',async()=>{const f=fixture([{seq:0,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'one'}]}},{seq:1,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},{seq:2,type:'turn/start',data:{}},{seq:3,type:'turn/end',data:{}}]);assert.equal((await verifyOfflineNativeClosure(f.input)).verified,true);});
test('a child that becomes resident or whose log changes between reads cannot verify',async()=>{
 for(const mutate of ['resident','log']){const f=fixture(),open=f.input.persistence.open;f.input.persistence.open=async(...args)=>{if(f.opens()===1){if(mutate==='resident')f.input.registry.get=()=>({id:'child'});else f.events[0].data.changed=true;}return open(...args);};await assert.rejects(verifyOfflineNativeClosure(f.input));assert.equal(f.closes(),f.opens());}
});
test('offline verification observes cancellation and closes its read handle',async()=>{const f=fixture(),abort=new AbortController(),open=f.input.persistence.open;f.input.signal=abort.signal;f.input.persistence.open=async(...args)=>{const handle=await open(...args),read=handle.read;handle.read=async(...input)=>{abort.abort(Error('stopped'));return read(...input);};return handle;};await assert.rejects(verifyOfflineNativeClosure(f.input),/stopped/);assert.equal(f.closes(),1);});
test('official invariant replay is mandatory and its rejection cannot be replaced by the stored digest',async()=>{
 for(const validateLog of [undefined,async()=>({validated:false}),async()=>{throw Error('official invariant rejected');}]){const f=fixture();f.input.validateLog=validateLog;await assert.rejects(verifyOfflineNativeClosure(f.input));assert.equal(f.closes(),f.opens());}
 const f=fixture();let calls=0;f.input.validateLog=async view=>{assert.equal(view.seq,2);assert.equal(Object.isFrozen(view),true);assert.equal(view.snapshotEvents()[1].type,'turn/end');calls++;return {validated:true};};assert.equal((await verifyOfflineNativeClosure(f.input)).verified,true);assert.equal(calls,2);
});
test('offline recovery requires the official projection cut and absence of a draining Session',async()=>{
 for(const change of [f=>{delete f.input.projections;},f=>{f.input.projections.snapshot=()=>({asOfSeq:0,values:{inbox:{'next-turn':[],'next-step':[]}}});},f=>{f.input.projections.snapshot=()=>({asOfSeq:1,values:{inbox:{'next-turn':[{}],'next-step':[]}}});},f=>{f.input.sessions.get=()=>({id:'child'});},f=>{const open=f.input.persistence.open;f.input.persistence.open=async()=>({...await open(),inheritedEventCount:1});}]){const f=fixture();change(f);await assert.rejects(verifyOfflineNativeClosure(f.input));assert.equal(f.closes(),f.opens());}
});
test('offline batch closure requires terminal evidence for that exact original call',async()=>{
 const history=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'tool/call',data:{callId:'read',name:'universe_read_page',arguments:{urls:['https://example.com']}}},{seq:2,type:'tool/result',data:{message:{toolCallId:'read'}}},{seq:3,type:'turn/end',data:{}}];
 const f=fixture(history),operation={session_ref:'child',request_id:'read',tool_name:'universe_read_page',operation_id:'web-aaaaaaaa',revision:1,status:'succeeded',accepted_count:1,items:[{item_id:'one',position:0,status:'succeeded'}]};
 await assert.rejects(verifyOfflineNativeClosure(f.input));f.input.proof.remote_operations=[operation];assert.equal((await verifyOfflineNativeClosure(f.input)).verified,true);
 for(const change of [p=>({...p,session_ref:'other'}),p=>({...p,status:'running'}),p=>({...p,items:[]}),p=>({...p,tool_name:'universe_execute'})]){f.input.proof.remote_operations=[change(operation)];await assert.rejects(verifyOfflineNativeClosure(f.input));}
});
