import test from 'node:test';import assert from 'node:assert/strict';
import {createFilePager} from './file-pages.mjs';
const row=index=>({path:`notes/${index}.txt`,version:1,size:1,sha256:'a'.repeat(64)});
test('file UI pager appends all pages once and retries failed continuation without duplicating prior rows',async()=>{
 let fail=true;const calls=[];
 const pager=createFilePager(async(cursor,signal)=>{calls.push(cursor);assert.ok(signal instanceof AbortSignal);if(cursor==='second'&&fail){fail=false;throw Error('offline');}return cursor?{items:Array.from({length:5},(_,i)=>row(i+200)),next_cursor:null}:{items:Array.from({length:200},(_,i)=>row(i)),next_cursor:'second'};});
 await pager.refresh();assert.equal(pager.getSnapshot().items.length,200);await pager.more();assert.equal(pager.getSnapshot().items.length,200);assert.match(pager.getSnapshot().error,/offline/);
 await pager.more();assert.equal(pager.getSnapshot().items.length,205);assert.equal(new Set(pager.getSnapshot().items.map(item=>item.path)).size,205);assert.equal(pager.getSnapshot().next_cursor,null);await pager.more();assert.deepEqual(calls,[undefined,'second','second']);
});
test('inventory conflict clears mixed UI rows and requires explicit refresh',async()=>{
 const pager=createFilePager(async cursor=>{if(cursor)throw Error('FILE_LIST_STATE_CONFLICT');return {items:[row(1)],next_cursor:'next'};});
 await pager.refresh();await pager.more();assert.deepEqual(pager.getSnapshot().items,[]);assert.equal(pager.getSnapshot().next_cursor,null);assert.match(pager.getSnapshot().error,/刷新/);await pager.refresh();assert.equal(pager.getSnapshot().items.length,1);
});
test('refresh and disposal abort prior reads and ignore late responses',async()=>{
 const pending=[];const pager=createFilePager((cursor,signal)=>new Promise(resolve=>pending.push({resolve,signal})));
 const old=pager.refresh();const current=pager.refresh();assert.equal(pending[0].signal.aborted,true);
 pending[1].resolve({items:[row(2)],next_cursor:null});await current;pending[0].resolve({items:[row(1)],next_cursor:'bad'});await old;assert.equal(pager.getSnapshot().items[0].path,row(2).path);
 const disposed=pager.refresh();pager.dispose();assert.equal(pending[2].signal.aborted,true);pending[2].resolve({items:[row(3)],next_cursor:null});await disposed;assert.deepEqual(pager.getSnapshot().items,[]);
});
