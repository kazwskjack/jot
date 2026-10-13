import test from 'node:test';import assert from 'node:assert/strict';
import {captureNativeChildClosure,verifyNativeChildPrefix} from '../native-child-closure.js';
function fixture(){
 const events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'turn/end',data:{}}],header={parentSession:'parent',delegationDepth:0};let closed=0;
 const agent={id:'child',status:'idle',whenIdle:async()=>{},session:{id:'child',header,seq:2,eventAt:i=>events[i]}};
 const handle={id:'child',access:'read',header,read:async(offset,count)=>({events:events.slice(offset,offset+count)}),close:async()=>closed++};
 const input={agent,parentSessionRef:'parent',registry:{get:()=>undefined},persistence:{flush:async()=>{},open:async()=>handle},projections:{stateOf:()=>({'next-turn':[],'next-step':[]})}};
 return {input,events,handle,closed:()=>closed};
}
test('exact detached durable log produces a closure receipt and closes its read handle',async()=>{const f=fixture();const receipt=await captureNativeChildClosure(f.input);assert.equal(receipt.turn_end_seq,1);assert.equal(receipt.seq_exclusive,2);assert.match(receipt.log_sha256,/^[a-f0-9]{64}$/);assert.equal(f.closed(),1);});
test('resident child cannot produce a closure even if idle',async()=>{const f=fixture();f.input.registry.get=()=>f.input.agent;await assert.rejects(captureNativeChildClosure(f.input),/native_child_not_detached/);assert.equal(f.closed(),0);});
test('queued native inbox prevents closure',async()=>{const f=fixture();f.input.projections.stateOf=()=>({'next-turn':['message'],'next-step':[]});await assert.rejects(captureNativeChildClosure(f.input),/native_child_pending_inbox/);});
test('durable log mismatch refuses closure and still closes the handle',async()=>{const f=fixture();f.handle.read=async()=>({events:[{seq:0,type:'turn/start',data:{changed:true}},f.events[1]]});await assert.rejects(captureNativeChildClosure(f.input),/native_child_storage_changed/);assert.equal(f.closed(),1);});
test('unresolved tool prevents quiescent closure',async()=>{const f=fixture();f.events.splice(1,0,{seq:1,type:'tool/call',data:{callId:'pending'}});f.events[2].seq=2;f.input.agent.session.seq=3;await assert.rejects(captureNativeChildClosure(f.input),/native_child_log_not_quiescent/);assert.equal(f.closed(),1);});
test('unknown tool outcome cannot produce a closure receipt',async()=>{const f=fixture();f.events.splice(1,0,{seq:1,type:'tool/result',data:{error:{code:'TOOL_OUTCOME_UNKNOWN'}}});f.events[2].seq=2;f.input.agent.session.seq=3;await assert.rejects(captureNativeChildClosure(f.input),/native_child_tool_unknown/);assert.equal(f.closed(),1);});

test('resumed Session must match the full recorded durable prefix before model admission',async()=>{const f=fixture(),proof=await captureNativeChildClosure(f.input);f.input.registry.get=()=>f.input.agent;await verifyNativeChildPrefix({...f.input,proof});f.events[0]={...f.events[0],data:{tampered:true}};await assert.rejects(verifyNativeChildPrefix({...f.input,proof}),/native_child_prefix_changed/);});
