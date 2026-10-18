import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAdapterHandler} from '../index.js';
import * as module from '../chat-maintenance-observation.js';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
function fixture(){
 const scope={owner_id:'u',conversation_id:'c',run_id:'r',session_ref:'s',expected_run_version:4};
 const source={protocol:1,kind:'chat_compaction_source',owner_id:'u',conversation_id:'c',run_id:'r',run_version:4,session_id:'s',history_sha256:'a'.repeat(64),model:{provider:'fixture',model:'fast',reasoning_effort:'off'},policy:{mode:'chat',thinking:'disabled'},execution_authorized:false};
 const proof={protocol:1,kind:'ordinary_run_completion',run_id:'r',run_version:4,session_id:'s',source_sha256:source.history_sha256,command_ids:[],native_message_ids:['native-input'],raw_event_count:8,raw_sha256:'b'.repeat(64),answer_sha256:'c'.repeat(64),answer_seq:5,turn_end_seq:7,profile_fingerprint:'d'.repeat(64),execution_authorized:false};
 const agent={id:'s',session:{id:'s',seq:8,header:{agentPreset:'jot-chat'},requestHeader:()=>({config:{provider:'fixture',model:'fast',reasoningEffort:'off'}})},status:'idle',inbox:{nextStep:[],nextTurn:[]}};
 const f={scope,source,proof,agent,reads:0,calls:[],tokens:50};
 f.options={agents:{get:()=>agent},completionReader:async()=>{f.reads++;return structuredClone(proof);},tokenMeter:{measure:()=>({logRevision:8,totalTokens:f.tokens})},llm:{resolveModelInfo:async()=>({context:{contextWindow:10000},defaultMaxTokens:1000})},pressurePolicy:{thresholdRatio:.8,headroomTokens:1000},bridge:{request:async(path,binding,body)=>{
  f.calls.push(body.action);assert.equal(path,'chat-compaction-source');assert.deepEqual(binding,{runId:'r',sessionRef:'s'});assert.equal(body.owner_id,'u');
  if(body.action==='inspect')return{source:structuredClone(source)};
  assert.equal(body.action,'verify-native');assert.ok(body.witness,'bounded native witness is missing');assert.equal(body.witness.proof_sha256,hash(proof));assert.ok(JSON.stringify(body).length<2048);return{observation:{protocol:1,kind:'chat_compaction_native',run_id:'r',session_id:'s',source_sha256:hash(source),proof_sha256:hash(proof),witness_sha256:hash(body.witness),raw_sha256:proof.raw_sha256,raw_event_count:8,answer_sha256:proof.answer_sha256,answer_seq:5,turn_end_seq:7,profile_fingerprint:proof.profile_fingerprint,execution_authorized:false}};
 }}};
 f.request=()=>({scope,expectedSourceSha256:hash(source),signal:new AbortController().signal});return f;
}
test('joins original completed source, native completion and effective pressure without executing maintenance',async()=>{
 assert.equal(typeof module.createChatMaintenanceObserver,'function');const f=fixture(),r=await module.createChatMaintenanceObserver(f.options)(f.request());assert.equal(r.kind,'chat_maintenance_observation');assert.equal(r.execution_authorized,false);assert.equal(r.pressure.reason,'LOW_PRESSURE');assert.equal(r.native.proof_sha256,hash(f.proof));assert.deepEqual(f.calls,['inspect','verify-native']);assert.equal(f.reads,2);
});
test('route, source, native sequence and completion drift cannot become maintenance advice',async()=>{
 for(const mode of ['source','owner','work','model','seq','proof','gateway']){
  const f=fixture(),q=f.request();if(mode==='source')q.expectedSourceSha256='f'.repeat(64);if(mode==='owner')q.scope={...q.scope,owner_id:'foreign'};if(mode==='work')f.agent.session.header.agentPreset='jot-general';if(mode==='model')f.source.model.reasoning_effort='high';if(mode==='seq')f.agent.session.seq++;if(mode==='proof')f.options.completionReader=async()=>({...f.proof,answer_seq:++f.reads});if(mode==='gateway'){const request=f.options.bridge.request;f.options.bridge.request=async(...args)=>{const r=await request(...args);if(r.observation)r.observation.proof_sha256='e'.repeat(64);return r;};}
  await assert.rejects(()=>module.createChatMaintenanceObserver(f.options)(q),undefined,mode);
 }
});
test('new work while resolving capacity revokes completed observation',async()=>{
 const f=fixture();f.options.llm.resolveModelInfo=async()=>{f.agent.inbox.nextTurn.push({});return{context:{contextWindow:10000}};};await assert.rejects(()=>module.createChatMaintenanceObserver(f.options)(f.request()));
});
test('high pressure remains advisory and returned metadata omits native answer bodies',async()=>{
 const f=fixture();f.tokens=9000;f.proof.answer_event={private_fixture:'synthetic answer bytes'};
 const r=await module.createChatMaintenanceObserver(f.options)(f.request());assert.equal(r.pressure.decision,'needed');assert.equal(r.execution_authorized,false);assert.equal(r.pressure.execution_authorized,false);assert.ok(!JSON.stringify(r).includes('synthetic answer bytes'));
});
test('large native tool and answer bodies stay local instead of crossing the bounded verification transport',async()=>{
 const f=fixture();f.proof.output_events=[{data:{synthetic:'x'.repeat(1200000)}}];f.proof.answer_event={data:{synthetic:'y'.repeat(1200000)}};
 const r=await module.createChatMaintenanceObserver(f.options)(f.request());assert.equal(r.native.proof_sha256,hash(f.proof));assert.ok(JSON.stringify(r).length<2048);
});
test('new input arriving during the final Gateway check invalidates all prior observations',async()=>{
 const f=fixture(),request=f.options.bridge.request;f.options.bridge.request=async(...args)=>{const r=await request(...args);if(r.observation)f.agent.inbox.nextStep.push({});return r;};await assert.rejects(()=>module.createChatMaintenanceObserver(f.options)(f.request()));
});
test('maintenance observation transport authenticates and refuses leases or arbitrary body fields',async()=>{
 const token='test-chat-maintenance-observation-token';let calls=0;const handler=createAdapterHandler({token,chatMaintenanceObserver:async value=>{calls++;assert.equal(value.scope.session_ref,'s');return{execution_authorized:false};}});
 const body={history:{owner_id:'u',conversation_id:'c',run_id:'r',expected_run_version:4},source_sha256:'a'.repeat(64)};
 const invoke=(payload,auth=token)=>handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions/s/chat-maintenance-observation'),headers:{authorization:'Bearer '+auth},body:payload});
 assert.equal((await invoke(body,'wrong')).status,401);assert.equal(calls,0);
 assert.equal((await invoke({...body,execution_lease:{owner:'old',generation:1}})).status,422);assert.equal(calls,0);assert.equal((await invoke(body)).status,200);assert.equal(calls,1);
 const off=createAdapterHandler({token});assert.equal((await off({method:'POST',url:new URL('http://127.0.0.1/v1/sessions/s/chat-maintenance-observation'),headers:{authorization:'Bearer '+token},body})).status,503);
});
