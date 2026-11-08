import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelRouteHealth} from '../model-route-health.js';

function fixture(){
 const listeners=new Map(),now={value:10_000};
 const ctx={on:(event,listener)=>{listeners.set(event,listener);return()=>listeners.delete(event);}};
 const health=createModelRouteHealth({ctx,now:()=>now.value,maxAgeMs:1000});
 const run=async(options,chunks,error)=>{
  const listener=listeners.get('llm/stream');assert.equal(typeof listener,'function');
  const stream=listener(options,()=>({async *[Symbol.asyncIterator](){if(error)throw error;for(const chunk of chunks)yield chunk;}}));
  const output=[];for await(const chunk of stream)output.push(chunk);return output;
 };
 return{health,now,listeners,run,close:()=>health.dispose()};
}

const route={provider:'provider-a',model:'model-a'};
const fallback={provider:'provider-b',model:'model-b'};
const options={...route,signal:new AbortController().signal};

test('real complete DSH model streams produce fresh route health and expiry remains visible',async()=>{
 const f=fixture();try{
  assert.deepEqual(f.health.read(...Object.values(route)),{status:'unknown',observed_at:null,expires_at:null});
  await f.run(options,[{type:'finish',reason:{kind:'stop'}}]);
  assert.deepEqual(f.health.read(route.provider,route.model),{status:'healthy',observed_at:10_000,expires_at:11_000});
  f.now.value=11_000;
  assert.deepEqual(f.health.read(route.provider,route.model),{status:'stale',observed_at:10_000,expires_at:11_000});
  f.now.value=11_001;
  assert.deepEqual(f.health.read(route.provider,route.model),{status:'stale',observed_at:10_000,expires_at:11_000});
 }finally{f.close();}
});

test('fresh provider failure permits only the first explicitly allowed non-failed fallback',async()=>{
 const f=fixture();try{
  await f.run(options,[{type:'finish',reason:{kind:'error',failure:{code:'SERVER',message:'private provider text'}}}]);
  assert.equal(f.health.read(route.provider,route.model).status,'unhealthy');
  assert.deepEqual(f.health.select(route,[fallback]),fallback);
  await f.run({...fallback,signal:options.signal},[{type:'finish',reason:{kind:'stop'}}]);
  assert.equal(f.health.read(fallback.provider,fallback.model).status,'healthy');
  assert.deepEqual(f.health.select(route,[fallback]),fallback);
 }finally{f.close();}
});

test('unknown or stale primary health stays on the accepted route; no unapproved or failed route is selected',async()=>{
 const f=fixture();try{
  assert.deepEqual(f.health.select(route,[fallback]),route);
  await f.run(options,[{type:'finish',reason:{kind:'error',failure:{code:'SERVER',message:'private'}}}]);
  assert.deepEqual(f.health.select(route,[]),null);
  assert.deepEqual(f.health.select(route,[fallback,{...fallback,provider:'provider-c'}]),fallback);
  f.now.value=11_000;
  assert.equal(f.health.read(route.provider,route.model).status,'stale');
  assert.deepEqual(f.health.select(route,[fallback]),route);
  await f.run(options,[{type:'finish',reason:{kind:'error',failure:{code:'SERVER',message:'private'}}}]);
  await f.run({...fallback,signal:options.signal},[{type:'finish',reason:{kind:'error',failure:{code:'TIMEOUT',message:'private'}}}]);
  assert.deepEqual(f.health.select(route,[fallback]),null);
 }finally{f.close();}
});

test('cancellation does not report provider health and route policy rejects malformed alternates',async()=>{
 const f=fixture();try{
  const controller=new AbortController();controller.abort(Error('cancelled'));
  await assert.rejects(f.run({...options,signal:controller.signal},[],Error('cancelled')),/cancelled/);
  assert.equal(f.health.read(route.provider,route.model).status,'unknown');
  for(const alternates of [[{...fallback,url:'https://untrusted.invalid'}],[route],[fallback,fallback]])
   assert.throws(()=>f.health.select(route,alternates),/model_route_policy_invalid/);
 }finally{f.close();}
});
