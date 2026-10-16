import test from 'node:test';import assert from 'node:assert/strict';
import {GoalReceiptStore} from './goal-receipts.mjs';
export const memoryStorage=()=>{const map=new Map();return {get length(){return map.size;},key:i=>[...map.keys()][i]??null,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
const scope='a'.repeat(64),command=(key='command-one')=>({body:{action:'pause',id:'goal-1',revision:1},key});
test('reopened stores recover only original owner/conversation commands, never their content',()=>{
 const storage=memoryStorage(),a=new GoalReceiptStore(storage,scope,'chat');a.save(command());
 assert.deepEqual(new GoalReceiptStore(storage,scope,'chat').pending(),[command()]);assert.deepEqual(new GoalReceiptStore(storage,'b'.repeat(64),'chat').pending(),[]);assert.deepEqual(new GoalReceiptStore(storage,scope,'other').pending(),[]);
 assert.doesNotMatch(storage.getItem(storage.key(0)),/objective|cookie|token|message/);
});
test('different tabs preserve separate commands and reject reusing a key with another body',()=>{
 const storage=memoryStorage(),a=new GoalReceiptStore(storage,scope,'chat'),b=new GoalReceiptStore(storage,scope,'chat');a.save(command());b.save(command('command-two'));assert.equal(a.pending().length,2);assert.throws(()=>b.save({...command(),body:{...command().body,revision:2}}));a.acknowledge(command());assert.deepEqual(b.pending(),[command('command-two')]);
});
test('malformed and mismatched records fail closed; acknowledgement tombstones survive pruning failures',()=>{
 const storage=memoryStorage(),a=new GoalReceiptStore(storage,scope,'chat');a.save(command());storage.setItem(storage.key(0),'{}');assert.throws(()=>a.pending());storage.removeItem(storage.key(0));
 storage.removeItem=()=>{throw Error('denied');};for(let i=0;i<25;i++){const c=command('command-'+i);a.save(c);a.acknowledge(c);}assert.deepEqual(a.pending(),[]);
});
test('silently dropped writes cannot claim a durable command',()=>{const storage=memoryStorage();storage.setItem=()=>{};assert.throws(()=>new GoalReceiptStore(storage,scope,'chat').save(command()),/goal_recovery_unavailable/);});
