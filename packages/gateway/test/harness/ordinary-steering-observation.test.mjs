import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionControllerClient} from '../../src/harness/session-controller-client.ts';
const module=await import('../../src/harness/ordinary-steering-observation.ts').catch(()=>({}));
const scope={owner_id:'owner-a',conversation_id:'conv-a',run_id:'run-a',command_id:'cmd-a',expected_run_version:4};
const view={protocol:1,kind:'ordinary_steer_observation',run_id:'run-a',command_id:'cmd-a',session_id:'session-a',run_version:4,run_status:'interrupted',command_status:'pending',native_state:'committed',original_native_message_id:'root-native',command_native_message_id:'cmd-native',profile_fingerprint:'a'.repeat(64),raw_event_count:10,raw_sha256:'b'.repeat(64),original_entry:'reserved',command_entry:'reserved',answer:{answer_sha256:'c'.repeat(64),answer_seq:7,turn_end_seq:9},execution_authorized:false};
test('history observation validates exact identity, nullable facts and raw sequence without accepting execution authority',()=>{
 const validate=module.validateOrdinarySteeringObservation;assert.equal(typeof validate,'function');assert.deepEqual(validate(view,'session-a',scope),view);
 for(const patch of [{run_id:'foreign'},{command_id:'foreign'},{session_id:'foreign'},{run_version:5},{execution_authorized:true},{raw_event_count:9},{answer:{...view.answer,answer_seq:9}},{native_state:'admitted'},{profile_fingerprint:null},{original_native_message_id:null},{command_native_message_id:'root-native'},{execution_lease:{owner:'borrowed',generation:1}}])assert.throws(()=>validate({...view,...patch},'session-a',scope));
 const unproven={...view,native_state:'unproven',original_native_message_id:null,command_native_message_id:null,profile_fingerprint:null,original_entry:null,command_entry:null,answer:null};assert.deepEqual(validate(unproven,'session-a',scope),unproven);
 assert.throws(()=>validate({...unproven,command_entry:'unreserved'},'session-a',scope));
});
test('Gateway client sends only explicit historical scope and rejects unconfirmed replies',async()=>{
 const calls=[],client=new SessionControllerClient('http://127.0.0.1:18841','t'.repeat(32),async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return Response.json(view);});
 assert.equal(typeof client.observeSteeringHistory,'function');assert.deepEqual(await client.observeSteeringHistory('session-a',scope),view);assert.ok(calls[0].url.endsWith('/sessions/session-a/steering-history'));assert.deepEqual(calls[0].body,{history:scope});
 for(const change of [{execution_lease:{owner:'old',generation:1}},{expected_run_version:'4'},{command_id:'run-a'},{owner_id:''}])await assert.rejects(()=>client.observeSteeringHistory('session-a',{...scope,...change}));assert.equal(calls.length,1);
 const foreign=new SessionControllerClient('http://127.0.0.1:18841','t'.repeat(32),async()=>Response.json({...view,run_id:'foreign'}));await assert.rejects(()=>foreign.observeSteeringHistory('session-a',scope));
});

test('bound history has a separately validated protocol and exact source digest, never a protocol-1 upgrade',async()=>{
 const validate=module.validateBoundOrdinarySteeringObservation,hashSource=module.ordinaryHistorySourceSha256;assert.equal(typeof validate,'function');assert.equal(typeof hashSource,'function');
 const sourceHash=hashSource({owner_id:'owner-a',payload_sha256:'a'.repeat(64)});assert.equal(sourceHash,hashSource({payload_sha256:'a'.repeat(64),owner_id:'owner-a'}));
 const bound={...view,protocol:2,source_sha256:sourceHash};assert.deepEqual(validate(bound,'session-a',scope,sourceHash),bound);assert.throws(()=>validate(view,'session-a',scope,sourceHash));assert.throws(()=>validate({...bound,source_sha256:'0'.repeat(64)},'session-a',scope,sourceHash));assert.throws(()=>module.validateOrdinarySteeringObservation(bound,'session-a',scope));
 const calls=[],client=new SessionControllerClient('http://127.0.0.1:18841','t'.repeat(32),async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return Response.json(bound);});assert.equal(typeof client.observeBoundSteeringHistory,'function');assert.deepEqual(await client.observeBoundSteeringHistory('session-a',scope,sourceHash),bound);assert.ok(calls[0].url.endsWith('/steering-history-v2'));assert.deepEqual(calls[0].body,{history:scope,source_sha256:sourceHash});await assert.rejects(()=>client.observeBoundSteeringHistory('session-a',scope,'invalid'));assert.equal(calls.length,1);
});
