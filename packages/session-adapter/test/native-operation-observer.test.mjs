import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeOperationObserver} from '../native-operation-observer.js';
const input={sessionRef:'child',callId:'original-call',toolName:'universe_read_page'};
const snapshot={operation_id:'web-'+ 'a'.repeat(32),kind:'read_page',revision:3,status:'succeeded',accepted_count:1,items:[{item_id:'one',position:0,status:'succeeded',private_input:'omit'}],private_data:'omit'};
test('scoped original-call lookup preserves only closure facts and checks authority twice',async()=>{
 const order=[];const observe=createNativeOperationObserver({origin:'http://127.0.0.1:18792',authorize:async value=>{assert.equal(value.sessionRef,'child');order.push('guard');},fetchImpl:async(url,options)=>{
 order.push('read');assert.equal(url,'http://127.0.0.1:18792/v2/native/tool');assert.equal(options.redirect,'error');const body=JSON.parse(options.body);
 assert.equal(body.tool,'universe_get_state');assert.equal(body.arguments.request_id,'original-call');assert.equal(body.execution.session_ref,'child');assert.notEqual(body.execution.call_id,'original-call');return {ok:true,json:async()=>snapshot};}});
 const proof=await observe(input);assert.deepEqual(order,['guard','read','guard']);assert.equal(proof.session_ref,'child');assert.equal(proof.request_id,'original-call');assert.equal(proof.private_data,undefined);assert.equal(proof.items[0].private_input,undefined);
});
test('observer refuses wrong kind, invalid identities, revoked authority and transport failures',async()=>{
 for(const change of [()=>({ok:false}),()=>({ok:true,json:async()=>({...snapshot,kind:'execute'})}),()=>{throw Error('secret remote failure');}]){
 const observe=createNativeOperationObserver({origin:'http://localhost:18792',authorize:async()=>{},fetchImpl:async()=>change()});await assert.rejects(observe(input),/native_operation_unresolved/);
 }
 let calls=0;const observe=createNativeOperationObserver({origin:'http://localhost:18792',authorize:async()=>{throw Error('revoked');},fetchImpl:async()=>{calls++;}});await assert.rejects(observe(input),/native_operation_unresolved/);assert.equal(calls,0);
 await assert.rejects(observe({...input,sessionRef:'../foreign'}),/native_operation_identity_invalid/);
});
test('only an explicit loopback root endpoint and trusted authority callback are accepted',()=>{
 const authenticated=new URL('http://localhost:18792');authenticated.username='fixture';
 for(const origin of ['https://example.com',authenticated.href,'http://localhost:18792/path','http://localhost:18792?target=x'])assert.throws(()=>createNativeOperationObserver({origin,authorize:async()=>{}}),/native_operation_config_invalid/);
 assert.throws(()=>createNativeOperationObserver({origin:'http://localhost:18792'}),/native_operation_config_invalid/);
});

test('revocation after reading and prior cancellation cannot produce a proof',async()=>{
 let checks=0,reads=0;const observe=createNativeOperationObserver({origin:'http://localhost:18792',authorize:async()=>{if(++checks===2)throw Error('revoked');},fetchImpl:async()=>{reads++;return {ok:true,json:async()=>snapshot};}});
 await assert.rejects(observe(input),/native_operation_unresolved/);assert.equal(reads,1);const abort=new AbortController();abort.abort();await assert.rejects(observe({...input,signal:abort.signal}),{name:'AbortError'});assert.equal(reads,1);
});
