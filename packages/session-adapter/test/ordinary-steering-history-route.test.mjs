import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdapterHandler,apply} from '../index.js';
const token='t'.repeat(32),history={owner_id:'owner-a',conversation_id:'conv-a',run_id:'run-a',command_id:'cmd-a',expected_run_version:4};
const url=new URL('http://127.0.0.1/v1/sessions/session-a/steering-history');
test('history transport authenticates exact historical scope and never invokes execution APIs',async()=>{
 let reads=0;const forbidden=()=>assert.fail('history must not execute');
 const handler=createAdapterHandler({token,controller:{create:forbidden,prompt:forbidden,resolveAgent:forbidden,follow:forbidden},ordinarySteeringObservationReader:async({scope,signal})=>{reads++;assert.deepEqual(scope,{...history,session_ref:'session-a'});assert.equal(signal.aborted,false);return{protocol:1,execution_authorized:false};}});
 const request=(body={history},headers={authorization:'Bearer '+token},method='POST')=>handler({method,url,headers,body});
 assert.equal((await request()).status,200);assert.equal(reads,1);assert.equal((await request({history},{})).status,401);assert.equal((await request({history},undefined,'GET')).status,405);
 for(const body of [{...history},{history:{...history,execution_lease:{owner:'old',generation:1}}},{history:{...history,text:'extra'}},{history:{...history,session_ref:'forged'}},{history:{...history,expected_run_version:'4'}},{history:{...history,command_id:'../other'}},{history:{...history,command_id:'run-a'}},{history,action:'resume'}])assert.equal((await request(body)).status,422);
 assert.equal(reads,1);
});
test('disabled history and failed proof return explicit read-only status without a fallback',async()=>{
 const invoke=(handler,body={history},path=url)=>handler({method:'POST',url:path,headers:{authorization:'Bearer '+token},body});
 const disabled=createAdapterHandler({token,controller:{prompt:()=>assert.fail('no fallback')}});assert.equal((await invoke(disabled)).status,503);
 assert.deepEqual((await invoke(disabled,{},new URL('http://127.0.0.1/v1/ordinary-input-history/readiness'))).value,{ready:false,protocol:1,execution_authorized:false});
 const failed=createAdapterHandler({token,controller:{},ordinarySteeringObservationReader:async()=>{throw Error('synthetic private diagnostics');}});
 assert.deepEqual(await invoke(failed),{status:409,value:{error:'ordinary_steering_observation_unconfirmed'}});
 assert.deepEqual((await invoke(failed,{},new URL('http://127.0.0.1/v1/ordinary-input-history/readiness'))).value,{ready:true,protocol:1,execution_authorized:false});
 assert.equal((await invoke(failed,{extra:true},new URL('http://127.0.0.1/v1/ordinary-input-history/readiness'))).status,422);
});
test('historical Host configuration cannot enable without trusted native and admission dependencies',()=>{
 const previous=process.env.JOT_SESSION_ADAPTER_TOKEN;process.env.JOT_SESSION_ADAPTER_TOKEN=token;
 try{for(const ordinaryInputHistory of [true,{},'enabled',{Session:{create(){}},validateLog(){},extra:true},{Session:{create(){}},validateLog(){}}])assert.throws(()=>apply({}, {ordinaryInputHistory}),/config/);}
 finally{if(previous===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=previous;}
});
