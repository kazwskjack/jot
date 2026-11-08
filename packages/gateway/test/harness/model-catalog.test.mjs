import test from 'node:test';
import assert from 'node:assert/strict';
import {readHostModelCatalog} from '../../src/harness/model-catalog.ts';
test('a transport ignoring cancellation cannot hold capability discovery after its deadline',async t=>{
 const controller=new AbortController();let deadline;
 t.mock.method(AbortSignal,'timeout',milliseconds=>{deadline=milliseconds;return controller.signal;});
 const pending=readHostModelCatalog({modelCatalog:async()=>new Promise(()=>{})});
 controller.abort();assert.deepEqual(await pending,[]);assert.equal(deadline,2000);
});
test('trusted host health freshness is projected and malformed health fails closed',async()=>{
 const model={provider:'fixture',model:'chosen',reasoning_output:'none',supported_reasoning_efforts:[],health:{status:'stale',observed_at:1000,expires_at:2000}};
 const client={modelCatalog:async()=>({protocol:1,ready:true,models:[model]})};
 assert.deepEqual(await readHostModelCatalog(client),[{...model,health:{...model.health}}]);
 for(const health of [{status:'healthy',observed_at:null,expires_at:null},{status:'healthy',observed_at:2000,expires_at:1000},{status:'unknown',observed_at:1000,expires_at:null},{status:'unhealthy',observed_at:1000,expires_at:2000,url:'https://untrusted.invalid'}]){
  assert.deepEqual(await readHostModelCatalog({modelCatalog:async()=>({protocol:1,ready:true,models:[{...model,health}]})}),[]);
 }
});
