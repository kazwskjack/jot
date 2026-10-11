import test from 'node:test';
import assert from 'node:assert/strict';
import {withNativeBudget,nativeBudgetForExecution,nativeRequestHash} from '../web-budget-context.js';

const execution=(label)=>({token:Symbol(label),callId:'call-'+label,name:'universe_search',
  agent:{id:'session-'+label},arguments:{query:label}});
test('exact native execution gets its ticket while sibling identities cannot borrow it',async()=>{
  const exec=execution('one');
  await withNativeBudget(exec,'a'.repeat(64),async()=>{
    assert.equal(nativeBudgetForExecution({...exec}), 'a'.repeat(64));
    for(const changed of [{...exec,token:Symbol('other')},{...exec,callId:'other'},
      {...exec,arguments:{query:'changed'}},{...exec,agent:{id:'other'}}])assert.throws(()=>nativeBudgetForExecution(changed),/native_budget/);
  });
  assert.equal(nativeBudgetForExecution(exec),undefined);
});
test('two overlapping async calls keep independent tickets and hashes',async()=>{
  let waiting=0,release;const ready=new Promise(resolve=>release=resolve);
  await Promise.all(['one','two'].map((label,index)=>{
    const exec=execution(label),ticket=String(index+1).repeat(64);
    return withNativeBudget(exec,ticket,async()=>{if(++waiting===2)release();await ready;
      assert.equal(nativeBudgetForExecution(exec),ticket);
      assert.match(nativeRequestHash(exec),/^[a-f0-9]{64}$/);});
  }));
});
test('descendant work cannot reuse authority after the execution wrapper settles',async()=>{
  const exec=execution('one');let late,release;const ready=new Promise(resolve=>release=resolve);
  await withNativeBudget(exec,'a'.repeat(64),async()=>{late=(async()=>{await ready;assert.throws(()=>nativeBudgetForExecution(exec),/native_budget/);})();});
  release();await late;
});
test('registered or absent tokens and non-ticket values are rejected before next',async()=>{
  const exec=execution('one');let called=0;
  for(const changed of [{...exec,token:undefined},{...exec,token:Symbol.for('untrusted')}])
    await assert.rejects(withNativeBudget(changed,'a'.repeat(64),async()=>called++),/native_budget/);
  await assert.rejects(withNativeBudget(exec,'bad',async()=>called++),/native_budget/);
  assert.equal(called,0);
});
