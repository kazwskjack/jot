import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFixtureReceipt} from './fixture-receipt.mjs';
test('synthetic fixture receipt retries only transient rename contention and keeps exact bytes',()=>{
 const calls=[],data={stage:'read-returned'},fs={writeFileSync:(...a)=>calls.push(['write',...a]),renameSync:(...a)=>{calls.push(['rename',...a]);if(calls.filter(c=>c[0]==='rename').length<3)throw Object.assign(Error('held'),{code:'EPERM'});}};
 writeFixtureReceipt('fixture.json',data,{fs,pause:ms=>calls.push(['pause',ms]),attempts:3});
 assert.deepEqual(calls.filter(c=>c[0]==='write'),[['write','fixture.json.new',JSON.stringify(data)]]);
 assert.equal(calls.filter(c=>c[0]==='rename').length,3);assert.equal(calls.filter(c=>c[0]==='pause').length,2);
});
test('fixture receipt fails visibly after bounded contention or any unrelated failure',()=>{
 for(const code of ['EPERM','EACCES','EBUSY','EIO']){let count=0,pauses=0;const failure=Object.assign(Error('synthetic failure'),{code});assert.throws(()=>writeFixtureReceipt('fixture.json',{}, {fs:{writeFileSync(){},renameSync(){count++;throw failure;}},pause(){pauses++;},attempts:3}),e=>e===failure);assert.equal(count,code!=='EIO'?3:1);assert.equal(pauses,code!=='EIO'?2:0);}
});
