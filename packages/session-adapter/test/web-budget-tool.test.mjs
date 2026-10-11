import test from 'node:test';
import assert from 'node:assert/strict';
import {runNativeBudgetedTool} from '../web-budget-tool.js';
import {nativeBudgetForExecution} from '../web-budget-context.js';
const fixture=()=>({token:Symbol('test-call'),callId:'call-one',name:'universe_search',agent:{id:'session-one'},arguments:{query:'example'}});
test('host mints the original call grant, runs inside exact scope and closes after quiescence',async()=>{
  const exec=fixture(),calls=[],binding={runId:'run-one',sessionRef:'session-one'};
  const result=await runNativeBudgetedTool({binding,exec,check:async()=>calls.push('guard'),
    request:async(path,original,payload,signal)=>{assert.equal(original,binding);calls.push(path);
      if(path.endsWith('/close')){assert.deepEqual(payload,{call_id:exec.callId});assert.equal(signal,undefined);return {closed:true};}
      assert.equal(payload.call_id,exec.callId);assert.equal(payload.tool_name,exec.name);assert.match(payload.request_hash,/^[a-f0-9]{64}$/);
      return {protocol:1,grant:'a'.repeat(64),expires_at:new Date(Date.now()+1000).toISOString()};},
    next:async()=>{calls.push('invoke');assert.equal(nativeBudgetForExecution(exec),'a'.repeat(64));return {ok:true};}});
  assert.deepEqual(result,{ok:true});assert.deepEqual(calls,['guard','web-budget-grant','guard','invoke','web-budget-grant/close']);
  assert.equal(nativeBudgetForExecution(exec),undefined);
});
test('unknown mint response or revoked authority never invokes and still attempts original close',async()=>{
  for(const unknown of [true,false]){let next=0,checks=0;const calls=[];
    await assert.rejects(runNativeBudgetedTool({binding:{runId:'run-one',sessionRef:'session-one'},exec:fixture(),
      check:async()=>{if(++checks===2)throw new Error('revoked');},next:async()=>next++,
      request:async(path)=>{calls.push(path);if(path.endsWith('/close'))return {closed:true};if(unknown)throw new Error('lost');return {protocol:1,grant:'a'.repeat(64),expires_at:new Date(Date.now()+1000).toISOString()};}}));
    assert.equal(next,0);assert.deepEqual(calls,['web-budget-grant','web-budget-grant/close']);}
});
test('foreign Session and invalid grant response cannot reach provider',async()=>{
  let next=0,requests=0;
  await assert.rejects(runNativeBudgetedTool({binding:{runId:'run-one',sessionRef:'other'},exec:fixture(),check:async()=>{},next:async()=>next++,request:async()=>requests++}),/native_budget/);
  assert.equal(requests,0);
  await assert.rejects(runNativeBudgetedTool({binding:{runId:'run-one',sessionRef:'session-one'},exec:fixture(),check:async()=>{},next:async()=>next++,request:async path=>path.endsWith('/close')?{closed:true}:{protocol:1,grant:'bad'}}),/native_budget/);
  assert.equal(next,0);
});
