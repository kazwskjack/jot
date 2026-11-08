import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerConversationForkRoutes} from '../../src/harness/conversation-fork-routes.ts';

for(const [reason,status,code] of [
 ['fork_attachment_count_invalid',413,'FORK_ATTACHMENT_COUNT_INVALID'],
 ['fork_attachment_aggregate_size_invalid',413,'FORK_ATTACHMENT_AGGREGATE_SIZE_INVALID'],
 ['unexpected_source_failure',503,'FORK_SOURCE_UNAVAILABLE'],
])test(`fork route preserves the no-effect boundary for ${reason}`,async t=>{
 const app=Fastify();t.after(()=>app.close());
 registerConversationForkRoutes(app,{
  forks:{fork:async()=>{throw Error(reason);}},actor:()=> 'fixture-owner',
  atomicCommand:()=>{assert.fail('a rejected fork cannot publish a success receipt');},
 });
 const response=await app.inject({method:'POST',url:'/v1/conversations/source/fork',
  headers:{'idempotency-key':'fixture-fork-key'},payload:{expected_version:1,through_message_id:'boundary'}});
 assert.equal(response.statusCode,status);assert.deepEqual(response.json(),{error:{code}});
});
