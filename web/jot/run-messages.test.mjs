import test from 'node:test';
import assert from 'node:assert/strict';
import {runMessages} from './run-messages.mjs';
test('multiple attempts produce one run container, separate runs remain separate',()=>{
 const messages=[{role:'user',message_id:'u',run_id:'r'},{role:'assistant',message_id:'a',run_id:'r'},{role:'assistant',message_id:'b',run_id:'r'},{role:'user',message_id:'u2',run_id:'r2'},{role:'assistant',message_id:'c',run_id:'r2'}];
 assert.deepEqual(runMessages(messages).map(m=>m.message_id),['u','b','u2','c']);
 assert.equal(messages.length,5);
});
test('independent runless replies remain separate rather than collapsing into one run container',()=>{
 const messages=[{role:'assistant',message_id:'reply-a',run_id:null},{role:'assistant',message_id:'reply-b',run_id:null}];assert.deepEqual(runMessages(messages).map(m=>m.message_id),['reply-a','reply-b']);
});
