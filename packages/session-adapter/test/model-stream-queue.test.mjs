import test from 'node:test';import assert from 'node:assert/strict';
import {BudgetedModelStreamQueue} from '../model-budget-stream.js';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const consume=async stream=>{for await(const value of stream){void value;}};
test('main and title streams share one admission queue until accounting closes',async()=>{
 const queue=new BudgetedModelStreamQueue(),started=deferred(),finish=deferred(),events=[];
 const main=consume(queue.run(undefined,async function*(){events.push('main-open');started.resolve();await finish.promise;yield 1;events.push('main-settled');}));await started.promise;
 const title=consume(queue.run(undefined,async function*(){events.push('title-open');yield 2;}));await Promise.resolve();assert.deepEqual(events,['main-open']);finish.resolve();await Promise.all([main,title]);assert.deepEqual(events,['main-open','main-settled','title-open']);
});
test('queued cancellation does not invoke a provider or interrupt the earlier stream',async()=>{
 const queue=new BudgetedModelStreamQueue(),started=deferred(),finish=deferred();let calls=0;
 const first=consume(queue.run(undefined,async function*(){started.resolve();await finish.promise;yield 1;}));await started.promise;
 const controller=new AbortController();const aborted=consume(queue.run(controller.signal,async function*(){calls++;yield 2;}));controller.abort();await assert.rejects(aborted);assert.equal(calls,0);
 const next=consume(queue.run(undefined,async function*(){calls++;yield 3;}));finish.resolve();await Promise.all([first,next]);assert.equal(calls,1);
});
test('different Session queues remain independent and failed streams release their slot',async()=>{
 const queue=new BudgetedModelStreamQueue(),other=new BudgetedModelStreamQueue(),started=deferred(),finish=deferred();
 const first=consume(queue.run(undefined,async function*(){started.resolve();await finish.promise;throw Error('fixture');}));const caught=assert.rejects(first);await started.promise;
 let ran=false;await consume(other.run(undefined,async function*(){ran=true;yield 1;}));assert.equal(ran,true);finish.resolve();await caught;await consume(queue.run(undefined,async function*(){yield 2;}));
});

test('an idle-gated title does not occupy the queue during main tools or later steps',async()=>{
 const queue=new BudgetedModelStreamQueue(),idle=deferred(),events=[];
 const title=consume(queue.run(undefined,async function*(){events.push('title');yield 1;},{ready:()=>idle.promise}));
 await consume(queue.run(undefined,async function*(){events.push('main-1');yield 1;}));events.push('tool');
 await consume(queue.run(undefined,async function*(){events.push('main-2');yield 1;}));assert.deepEqual(events,['main-1','tool','main-2']);idle.resolve();await title;assert.equal(events.at(-1),'title');
});

test('cancelling an idle-gated title leaves main admission available',async()=>{
 const queue=new BudgetedModelStreamQueue(),idle=deferred(),controller=new AbortController();let titleCalls=0,mainCalls=0;
 const title=consume(queue.run(controller.signal,async function*(){titleCalls++;yield 1;},{ready:()=>idle.promise}));
 controller.abort();await assert.rejects(title);
 await consume(queue.run(undefined,async function*(){mainCalls++;yield 1;}));
 idle.resolve();await Promise.resolve();assert.equal(titleCalls,0);assert.equal(mainCalls,1);
});
