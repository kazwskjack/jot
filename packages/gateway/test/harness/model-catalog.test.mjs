import test from 'node:test';
import assert from 'node:assert/strict';
import {readHostModelCatalog} from '../../src/harness/model-catalog.ts';
test('a transport ignoring cancellation cannot hold capability discovery after its deadline',async t=>{
 const controller=new AbortController();let deadline;
 t.mock.method(AbortSignal,'timeout',milliseconds=>{deadline=milliseconds;return controller.signal;});
 const pending=readHostModelCatalog({modelCatalog:async()=>new Promise(()=>{})});
 controller.abort();assert.deepEqual(await pending,[]);assert.equal(deadline,2000);
});
