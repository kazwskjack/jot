import test from 'node:test';import assert from 'node:assert/strict';
import {createAdapterHandler,apply} from '../index.js';
const token='t'.repeat(32),history={owner_id:'u',conversation_id:'c',run_id:'r',expected_run_version:4},sourceHash='a'.repeat(64);
const url=path=>new URL('http://127.0.0.1'+path);
const invoke=(handler,body={history,source_sha256:sourceHash},headers={authorization:'Bearer '+token},path='/v1/sessions/s/run-history-completion')=>handler({method:'POST',url:url(path),headers,body});
test('full completion transport requires exact source-bound metadata and authentication, without execution APIs',async()=>{
 let calls=0;const forbidden=()=>assert.fail('read-only history must not execute'),handler=createAdapterHandler({token,controller:{prompt:forbidden,resolveAgent:forbidden,create:forbidden,follow:forbidden},ordinaryRunCompletionReader:async({scope,expectedSourceSha256,signal})=>{calls++;assert.deepEqual(scope,{...history,session_ref:'s'});assert.equal(expectedSourceSha256,sourceHash);assert.equal(signal.aborted,false);return{protocol:1,execution_authorized:false};}});
 assert.equal((await invoke(handler)).status,200);assert.equal((await invoke(handler,undefined,{})).status,401);
 for(const body of [{history},{history,source_sha256:'bad'},{history:{...history,session_ref:'forged'},source_sha256:sourceHash},{history:{...history,expected_run_version:'4'},source_sha256:sourceHash},{history:{...history,command_id:'extra'},source_sha256:sourceHash},{history,source_sha256:sourceHash,execution_lease:{owner:'old',generation:1}},{history,source_sha256:sourceHash,text:'never resend'}])assert.equal((await invoke(handler,body)).status,422);
 assert.equal(calls,1);
});
test('full completion has separate disabled/readiness/error contracts and no diagnostic leakage or legacy fallback',async()=>{
 const disabled=createAdapterHandler({token,controller:{}});assert.equal((await invoke(disabled)).status,503);assert.deepEqual((await invoke(disabled,{},undefined,'/v1/ordinary-run-history/readiness')).value,{ready:false,protocol:1,execution_authorized:false});
 const failed=createAdapterHandler({token,controller:{},ordinaryRunCompletionReader:async()=>{throw Error('synthetic private diagnostic');}});assert.deepEqual(await invoke(failed),{status:409,value:{error:'ordinary_run_completion_unconfirmed'}});assert.deepEqual((await invoke(failed,{},undefined,'/v1/ordinary-run-history/readiness')).value,{ready:true,protocol:1,execution_authorized:false});assert.equal((await invoke(failed,{action:'publish'},undefined,'/v1/ordinary-run-history/readiness')).status,422);
});
test('new historical final-reader configuration requires explicit trusted kit and existing immutable admissions',()=>{
 const previous=process.env.JOT_SESSION_ADAPTER_TOKEN;process.env.JOT_SESSION_ADAPTER_TOKEN=token;
 try{for(const ordinaryRunHistory of [true,{},'active',{Session:{create(){}},validateLog(){},extra:true},{Session:{create(){}},validateLog(){}}])assert.throws(()=>apply({}, {ordinaryRunHistory}),/config/);}finally{if(previous===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=previous;}
});
