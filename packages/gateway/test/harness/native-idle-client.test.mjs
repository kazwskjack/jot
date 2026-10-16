import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionControllerClient} from '../../src/harness/session-controller-client.ts';
const token='t'.repeat(40);
const fact=(patch={})=>({protocol:1,session_id:'session-1',basis:'live',native_idle:'idle',reason:null,observed_at:123,execution_authorized:false,...patch});
function fixture(value){const calls=[];return {calls,client:new SessionControllerClient('http://127.0.0.1:18841',token,async(url,init)=>{calls.push({url,init});return Response.json(value);})};}
test('native idle client sends only an authenticated read and preserves non-authorizing fact',async()=>{
 const x=fixture(fact()),result=await x.client.observeNativeIdle('session-1');assert.deepEqual(result,fact());assert.ok(Object.isFrozen(result));
 assert.equal(x.calls[0].url,'http://127.0.0.1:18841/v1/sessions/session-1/idle-observation');assert.equal(x.calls[0].init.method,'POST');assert.equal(x.calls[0].init.headers.authorization,'Bearer '+token);assert.equal(x.calls[0].init.body,'{"protocol":1}');assert.ok(x.calls[0].init.signal instanceof AbortSignal);
});
test('native idle client rejects malformed session identity before fetch',async()=>{for(const id of ['', '../other', 'a/b', 'a'.repeat(193),null]){const x=fixture(fact());await assert.rejects(()=>x.client.observeNativeIdle(id),/native_idle_observation_invalid/);assert.equal(x.calls.length,0);}});
test('native idle client validates exact fields, identity, timestamp and authority',async()=>{
 for(const patch of [{protocol:2},{session_id:'other'},{extra:'private'},{observed_at:-1},{observed_at:1.5},{observed_at:'123'},{execution_authorized:true},{basis:'remote'},{native_idle:'ready'},{reason:'private exception'}])await assert.rejects(()=>fixture(fact(patch)).client.observeNativeIdle('session-1'),/native_idle_observation_invalid/);
 for(const key of Object.keys(fact())){const value=fact();delete value[key];await assert.rejects(()=>fixture(value).client.observeNativeIdle('session-1'),/native_idle_observation_invalid/);}
});
test('native idle client checks basis/state/reason consistency without promoting unknown',async()=>{
 const valid=[['live','busy','AGENT_RUNNING'],['live','busy','INPUT_PENDING'],['live','busy','GOAL_ARMED'],['cold','busy','INPUT_PENDING'],['cold','busy','GOAL_ARMED'],['cold','busy','PERSISTED_GOAL_ACTIVE'],['cold','idle',null],['absent','unknown','SESSION_MISSING'],['unavailable','unknown','STATE_UNAVAILABLE'],['live','unknown','STATE_CHANGED'],['cold','unknown','STATE_CHANGED'],['live','unknown','STATE_UNAVAILABLE'],['cold','unknown','STATE_UNAVAILABLE']];
 for(const [basis,native_idle,reason]of valid)assert.deepEqual(await fixture(fact({basis,native_idle,reason})).client.observeNativeIdle('session-1'),fact({basis,native_idle,reason}));
 for(const [basis,native_idle,reason]of [['absent','idle',null],['unavailable','idle',null],['live','busy',null],['live','idle','GOAL_ARMED'],['cold','busy','AGENT_RUNNING'],['live','busy','PERSISTED_GOAL_ACTIVE'],['absent','unknown','STATE_CHANGED'],['cold','unknown',null]])await assert.rejects(()=>fixture(fact({basis,native_idle,reason})).client.observeNativeIdle('session-1'),/native_idle_observation_invalid/);
});
test('native idle readiness accepts only exact non-authorizing protocol',async()=>{
 for(const ready of [true,false]){const value={protocol:1,ready,execution_authorized:false},x=fixture(value);assert.deepEqual(await x.client.nativeIdleObservationReadiness(),value);assert.equal(x.calls[0].url,'http://127.0.0.1:18841/v1/native-idle-observation/readiness');assert.equal(x.calls[0].init.body,'{}');}
 for(const value of [null,[],{protocol:1,ready:true},{protocol:1,ready:'yes',execution_authorized:false},{protocol:1,ready:true,execution_authorized:true},{protocol:1,ready:true,execution_authorized:false,extra:1}])await assert.rejects(()=>fixture(value).client.nativeIdleObservationReadiness(),/native_idle_readiness_invalid/);
});
test('transport refusal or cancellation cannot become a positive idle observation',async()=>{
 const denied=new SessionControllerClient('http://127.0.0.1:18841',token,async()=>Response.json({error:'native_idle_observation_unavailable'},{status:503}));
 await assert.rejects(()=>denied.observeNativeIdle('session-1'),error=>error.status===503);
 const abort=new AbortController();abort.abort();let signal;
 const client=new SessionControllerClient('http://127.0.0.1:18841',token,async(url,init)=>{signal=init.signal;signal.throwIfAborted();return Response.json(fact());});
 await assert.rejects(()=>client.observeNativeIdle('session-1',abort.signal));assert.equal(signal.aborted,true);
});
