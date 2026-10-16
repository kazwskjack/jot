import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdapterHandler} from '../index.js';
import {readNativeIdleObservation as read} from '../native-idle-observation.js';
const token='test-native-idle-observation-token';
function live(){const goal={id:'goal',revision:1,phase:'active',activation:'disarmed'},agent={id:'s',session:{id:'s'},status:'idle',inbox:{nextTurn:[],nextStep:[]},ctx:{get:()=>({get:()=>goal})}};return{agent,goal,agents:{get:()=>agent}};}
const cold=()=>({values:{agentPreset:'jot-general',inbox:{'next-turn':[],'next-step':[]},goal:null}});
const invoke=(handler,path,body={},auth=token)=>handler({method:'POST',url:new URL('http://127.0.0.1'+path),headers:{authorization:'Bearer '+auth},body});
const observation=(extra={})=>read({sessionId:'s',signal:new AbortController().signal,allowedPresets:new Set(['jot-general']),...extra});
test('live quiescence is factual read-only advice, with no prompt/create/resolve',async()=>{
 assert.equal(typeof read,'function');const f=live(),before=JSON.stringify(f.agent);
 const value=await observation({agents:f.agents,controller:{create:()=>assert.fail(),prompt:()=>assert.fail(),resolveAgent:()=>assert.fail()}});
 assert.equal(value.native_idle,'idle');assert.equal(value.basis,'live');assert.equal(value.execution_authorized,false);assert.equal(value.session_id,'s');assert.equal(Number.isSafeInteger(value.observed_at),true);assert.equal(JSON.stringify(f.agent),before);
 assert.deepEqual(Object.keys(value).sort(),['basis','execution_authorized','native_idle','observed_at','protocol','reason','session_id']);
});
for(const [mutate,reason] of [
 [f=>f.agent.status='running','AGENT_RUNNING'],[f=>f.agent.inbox.nextTurn.push({text:'private'}),'INPUT_PENDING'],
 [f=>f.agent.inbox.nextStep.push({text:'private'}),'INPUT_PENDING'],[f=>f.goal.activation='armed','GOAL_ARMED'],
])test('live busy fact: '+reason,async()=>{const f=live();mutate(f);const result=await observation({agents:f.agents});assert.equal(result.native_idle,'busy');assert.equal(result.reason,reason);assert.equal(result.execution_authorized,false);assert.ok(!JSON.stringify(result).includes('private'));});
for(const mutate of [f=>f.agent.id='foreign',f=>delete f.agent.inbox,f=>f.agent.status='invented',f=>f.agent.ctx={get:()=>undefined},f=>f.goal.activation='invented'])test('missing or malformed live facts stay unknown',async()=>{const f=live();mutate(f);assert.equal((await observation({agents:f.agents})).native_idle,'unknown');});
test('cold reads require stable real projections and leave the Agent registry empty',async()=>{
 let reads=0;const agents={get:()=>undefined},controller={projections:async()=>{reads++;return cold();},resolveAgent:()=>assert.fail('no resolution'),create:()=>assert.fail('no creation'),prompt:()=>assert.fail('no prompt')};
 const result=await observation({agents,controller});assert.equal(result.native_idle,'idle');assert.equal(result.basis,'cold');assert.equal(reads,2);assert.equal(result.execution_authorized,false);
});
for(const [projection,expected] of [[null,'unknown'],[{values:{}},'unknown'],[{values:{...cold().values,inbox:{'next-turn':[{}],'next-step':[]}}},'busy'],[{values:{...cold().values,goal:{goal:{id:'g',revision:1,phase:'active'}}}},'busy']])test('cold missing/pending/active state is not successful idle',async()=>{
 const result=await observation({agents:{get:()=>undefined},controller:{projections:async()=>projection}});assert.equal(result.native_idle,expected);assert.equal(result.execution_authorized,false);
});
test('mutable projections and Agent attachment across awaited reads invalidate the observation',async()=>{
 const shared=cold();let count=0;const controller={projections:async()=>{if(++count===2)shared.values.inbox['next-step'].push({});return shared;}};
 assert.equal((await observation({agents:{get:()=>undefined},controller})).native_idle,'unknown');
 let attached;const f=live();assert.equal((await observation({agents:{get:()=>attached},controller:{projections:async()=>{attached=f.agent;return cold();}}})).native_idle,'unknown');
});
test('live Goal or registry changes invalidate positive idle evidence',async()=>{
 const f=live();let gets=0;f.agent.ctx.get=()=>({get:()=>{if(++gets===2)f.goal.revision++;return f.goal;}});
 assert.equal((await observation({agents:f.agents})).reason,'STATE_CHANGED');
 const g=live();let reads=0;assert.equal((await observation({agents:{get:()=>++reads===1?g.agent:{...g.agent}}})).reason,'STATE_CHANGED');
});
test('abort and projection failure do not create an Agent or expose raw errors',async()=>{
 const abort=new AbortController();abort.abort();await assert.rejects(()=>observation({signal:abort.signal,agents:{get:()=>assert.fail('aborted before access')}}));
 const result=await observation({agents:{get:()=>undefined},controller:{projections:async()=>{throw Error('private diagnostic');}}});assert.equal(result.native_idle,'unknown');assert.ok(!JSON.stringify(result).includes('private'));
});
test('bearer authentication, exact request shape and opt-in readiness precede all observation',async()=>{
 let reads=0;const f=live(),handler=createAdapterHandler({token,nativeIdleObservation:true,agents:{get:()=>{reads++;return f.agent;}},controller:{projections:async()=>cold()}});
 assert.equal((await invoke(handler,'/v1/sessions/s/idle-observation',{protocol:1},'wrong')).status,401);assert.equal(reads,0);
 for(const body of [{},{protocol:2},{protocol:1,action:'resume'},{protocol:1,owner_id:'other'}])assert.equal((await invoke(handler,'/v1/sessions/s/idle-observation',body)).status,422);
 assert.equal(reads,0);const ready=await invoke(handler,'/v1/native-idle-observation/readiness');assert.deepEqual(ready.value,{protocol:1,ready:true,execution_authorized:false});assert.equal(reads,0);
 assert.equal((await invoke(handler,'/v1/sessions/s/idle-observation',{protocol:1})).value.native_idle,'idle');
 const disabled=createAdapterHandler({token,agents:f.agents,controller:{projections:async()=>cold()}});
 assert.equal((await invoke(disabled,'/v1/sessions/s/idle-observation',{protocol:1})).status,503);assert.equal((await invoke(disabled,'/v1/native-idle-observation/readiness')).value.ready,false);
});
