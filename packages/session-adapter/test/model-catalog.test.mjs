import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createAdapterHandler} from '../index.js';
import {createModelCatalogReader} from '../model-catalog.js';
const token=randomBytes(32).toString('hex');
test('model catalog transport is internally authenticated and accepts no page-supplied configuration',async()=>{
 let calls=0;const handler=createAdapterHandler({token,controller:{},modelCatalogReader:async()=>{calls++;return{protocol:1,ready:true,models:[]};}});
 const request=(body={},authorization=`Bearer ${token}`)=>handler({method:'POST',url:new URL('http://127.0.0.1/v1/models'),headers:{authorization},body,signal:new AbortController().signal});
 assert.equal((await request({},'Bearer fixture-wrong')).status,401);assert.equal(calls,0);
 assert.equal((await request({api_key:'fixture-untrusted'})).status,422);assert.equal(calls,0);
 assert.equal((await request()).status,200);assert.equal(calls,1);
});

function catalog(){return{listProviders:()=>[{id:'fixture',privateConfig:'fixture-private'}],listModels:async()=>[{id:'chosen',name:'Private label',credential:'fixture-private'}],resolveModelInfo:async(provider,id)=>({provider,id,reasoning:{efforts:[{id:'low'},{id:'high'}]},privateConfig:'fixture-private'})};}
test('only detached model identities and supported effort IDs leave the native catalog',async()=>{
 const read=createModelCatalogReader({llm:catalog(),enabled:true}),value=await read();
 assert.deepEqual(value,{protocol:1,ready:true,models:[{provider:'fixture',model:'chosen',reasoning_output:'none',supported_reasoning_efforts:['low','high']}]});
 assert.ok(!JSON.stringify(value).includes('fixture-private'));
});
test('disabled metadata makes no provider calls and provider errors expose no exception body',async()=>{
 const llm=catalog();let calls=0;llm.listModels=async()=>{calls++;throw Error('fixture-private');};
 assert.deepEqual(await createModelCatalogReader({llm})(),{protocol:1,ready:false,models:[]});assert.equal(calls,0);
 const result=await createModelCatalogReader({llm,enabled:true})();assert.equal(result.ready,false);assert.ok(!JSON.stringify(result).includes('fixture-private'));
});
test('catalog cancellation reaches provider resolution and cannot publish a late directory',async()=>{
 const llm=catalog(),controller=new AbortController(),entered=Promise.withResolvers();let observed;
 llm.resolveModelInfo=async(_provider,_id,signal)=>{observed=signal;entered.resolve();return new Promise((done,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 const pending=createModelCatalogReader({llm,enabled:true})(controller.signal);await entered.promise;controller.abort();
 assert.deepEqual(await pending,{protocol:1,ready:false,models:[]});assert.equal(observed.aborted,true);
});
