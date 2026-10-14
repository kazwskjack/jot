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

function batchFixture(){const f=fixture();f.events.splice(1,0,
 {seq:1,type:'tool/call',data:{callId:'remote-call',name:'universe_read_page',arguments:{urls:['https://example.com/a','https://example.org/b']}}},
 {seq:2,type:'tool/result',data:{message:{source:{kind:'tool',callId:'remote-call'},content:[{type:'text',text:'Accepted for background processing'}]}}});
 f.events[3].seq=3;f.input.agent.session.seq=4;return f;}
const settledOperation=()=>({session_ref:'child',request_id:'remote-call',operation_id:'web-'+ 'a'.repeat(32),revision:2,status:'succeeded',accepted_count:2,items:[{item_id:'one',position:0,status:'succeeded'},{item_id:'two',position:1,status:'succeeded'}]});

test('a returned batch tool cannot close a member without original operation reconciliation',async()=>{
 const f=batchFixture();await assert.rejects(captureNativeChildClosure(f.input),/native_child_remote_effects_unresolved/);assert.equal(f.closed(),1);
});

test('only a complete terminal operation from the exact original Session and call permits closure',async()=>{
 for(const change of [proof=>({...proof,status:'running'}),proof=>({...proof,session_ref:'other'}),proof=>({...proof,request_id:'other'}),proof=>({...proof,accepted_count:undefined}),proof=>({...proof,items:proof.items.slice(0,1)}),proof=>({...proof,items:[proof.items[0],proof.items[0]]})]){
  const f=batchFixture();f.input.reconcileOperations=async()=>change(settledOperation());await assert.rejects(captureNativeChildClosure(f.input),/native_child_remote_effects_unresolved/);
 }
 const f=batchFixture();f.input.reconcileOperations=async input=>{assert.equal(input.sessionRef,'child');assert.equal(input.callId,'remote-call');assert.equal(input.toolName,'universe_read_page');assert.equal(Object.isFrozen(input),true);return settledOperation();};
 assert.equal((await captureNativeChildClosure(f.input)).driver_nonresident,true);assert.equal(f.closed(),1);
});

test('batch syntax requires reconciliation even for one item and JSON-encoded arguments',async()=>{
 for(const [name,args] of [['universe_read_page',{urls:['https://example.com']}],['universe_execute',{inputs:{items:[{action:'click'}]}}],['universe_browse',{inputs:{items:[{url:'https://example.com'}]}}]]){
  const f=batchFixture();f.events[1].data.name=name;f.events[1].data.arguments=JSON.stringify(args);
  await assert.rejects(captureNativeChildClosure(f.input),/native_child_remote_effects_unresolved/);
 }
});

test('an operation observation cannot mask a Session change during reconciliation',async()=>{
 const f=batchFixture();f.input.reconcileOperations=async()=>{f.input.agent.session.seq++;return settledOperation();};
 await assert.rejects(captureNativeChildClosure(f.input),/native_child_live_changed/);
});

test('resumed Session must match the full recorded durable prefix before model admission',async()=>{const f=fixture(),proof=await captureNativeChildClosure(f.input);f.input.registry.get=()=>f.input.agent;await verifyNativeChildPrefix({...f.input,proof});f.events[0]={...f.events[0],data:{tampered:true}};await assert.rejects(verifyNativeChildPrefix({...f.input,proof}),/native_child_prefix_changed/);});

test('validated external closure facts are retained without arbitrary observer data',async()=>{
 const f=batchFixture();f.input.reconcileOperations=async()=>({...settledOperation(),private_input:'omit'});const proof=await captureNativeChildClosure(f.input);
 assert.deepEqual(proof.remote_operations,[{...settledOperation(),tool_name:'universe_read_page'}]);assert.equal(proof.remote_operations[0].private_input,undefined);
});

test('recovery requires stored terminal proofs for exactly the batch calls in the recorded prefix',async()=>{
 const f=batchFixture();f.input.reconcileOperations=async()=>settledOperation();const proof=await captureNativeChildClosure(f.input);
 await verifyNativeChildPrefix({...f.input,proof});
 for(const remote_operations of [undefined,[],[{...proof.remote_operations[0],request_id:'foreign'}],[{...proof.remote_operations[0],tool_name:'universe_execute'}],[{...proof.remote_operations[0],status:'running'}],[proof.remote_operations[0],proof.remote_operations[0]]])await assert.rejects(verifyNativeChildPrefix({...f.input,proof:{...proof,remote_operations}}),/native_child_prefix_remote_unresolved/);
});
