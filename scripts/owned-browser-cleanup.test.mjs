import test from 'node:test';
import assert from 'node:assert/strict';
import * as cleanup from './owned-browser-cleanup.mjs';

test('owned-browser cleanup preserves the original failure and reports every cleanup failure', async()=>{
 assert.equal(typeof cleanup.finalizeTestWithCleanup,'function','the test finalizer must preserve the body error across cleanup failures');
 const originalError=new Error('synthetic body failure'),closeError=new Error('synthetic browser close failure'),removeError=new Error('synthetic profile remove failure');
 let removed=false,reported;
 await assert.rejects(cleanup.finalizeTestWithCleanup(originalError,[
  {operation:'owned_browser_close',action:async()=>{throw closeError;}},
  {operation:'owned_profile_remove',action:async()=>{removed=true;throw removeError;}},
 ],failures=>{reported=failures;}),error=>error===originalError);
 assert.equal(removed,true,'profile cleanup still runs after browser close fails');
 assert.deepEqual(reported.map(failure=>failure.operation),['owned_browser_close','owned_profile_remove']);
 assert.equal(reported[0].error,closeError);
 assert.equal(reported[1].error,removeError);
});

test('owned-browser cleanup fails the test when cleanup alone fails', async()=>{
 assert.equal(typeof cleanup.finalizeTestWithCleanup,'function');
 const cleanupError=new Error('synthetic profile remove failure');
 await assert.rejects(cleanup.finalizeTestWithCleanup(null,[
  {operation:'owned_profile_remove',action:async()=>{throw cleanupError;}},
 ]),error=>error instanceof AggregateError&&error.errors[0]===cleanupError);
});
