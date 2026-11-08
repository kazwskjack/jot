import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryReasoningAdapter} from '../../src/workbench/memory-reasoning-adapter.ts';

const candidates=[
 {memory_id:'memory-1',version:2,content:'Ferry schedule: the last sailing is at 18:00.',owner_id:'alice',scope:'private',provenance:[{reference:'private.md'}]},
 {memory_id:'memory-2',version:1,content:'The clinic closes at 17:00.',owner_id:'alice',scope:'private'},
];

test('adapter sends only the bounded authorized candidate projection and validates selected source IDs',async()=>{
 let received;
 const adapter=new MemoryReasoningAdapter({selectCandidates:async input=>{received=input;return{selected_ids:['memory-1']};}});
 const result=await adapter.select({query:'When is the ferry?',candidates,limit:2});
 assert.deepEqual(Object.keys(received).sort(),['candidates','limit','query']);
 assert.deepEqual(received.candidates,[
  {memory_id:'memory-1',version:2,content:'Ferry schedule: the last sailing is at 18:00.'},
  {memory_id:'memory-2',version:1,content:'The clinic closes at 17:00.'},
 ]);
 assert.deepEqual(result,{method:'reasoning_provider',candidate_count:2,selected_ids:['memory-1'],references:[{memory_id:'memory-1',version:2,rank:1,reason:'reasoning_provider'}]});
 received.candidates[0].content='mutated';assert.equal(candidates[0].content,'Ferry schedule: the last sailing is at 18:00.');
});

test('adapter rejects foreign, duplicate and excessive selections and sanitizes provider errors',async()=>{
 for(const selected_ids of [['foreign-memory'],['memory-1','memory-1'],['memory-1','memory-2']]){
  const adapter=new MemoryReasoningAdapter({selectCandidates:async()=>({selected_ids})});
  await assert.rejects(adapter.select({query:'q',candidates,limit:1}),/^Error: memory_reasoning_result_invalid$/);
 }
 const failed=new MemoryReasoningAdapter({selectCandidates:async()=>{throw new Error('private provider detail');}});
 await assert.rejects(failed.select({query:'q',candidates,limit:1}),/^Error: memory_reasoning_provider_failed$/);
});

test('adapter skips empty candidate sets and rejects malformed or oversized inputs before provider access',async()=>{
 let calls=0;const adapter=new MemoryReasoningAdapter({selectCandidates:async()=>{calls++;return{selected_ids:[]};}});
 assert.deepEqual(await adapter.select({query:'q',candidates:[]}),{method:'reasoning_provider',candidate_count:0,selected_ids:[],references:[]});
 for(const input of [
  {query:' ',candidates},
  {query:'q',candidates:[candidates[0],candidates[0]]},
  {query:'q',candidates:[{memory_id:'too-large',version:1,content:'x'.repeat(20_001)}]},
 ])await assert.rejects(adapter.select(input));
 assert.equal(calls,0);
});
