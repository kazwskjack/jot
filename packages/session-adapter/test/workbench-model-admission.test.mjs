import test from 'node:test';import assert from 'node:assert/strict';import {createAdapterHandler} from '../index.js';
test('formal reattachment recovers original control before restoring dispatch and keeps unresolved return blocked',async()=>{
 const agent={id:'root'},binding={runId:'run',sessionRef:'root'},calls=[];let blocked=false;
 const options={token:'a'.repeat(32),controller:{create:async()=>({session_id:'root'}),prompt:async()=>{calls.push('prompt');return {accepted:true};}},agents:{get:()=>agent},workbenchBridge:{request:async()=>({context:{}}),attach:async()=>calls.push('attach'),taskRootBindingFor:()=>binding,guard:async()=>{}},nativeTaskScheduler:{restore:async()=>{calls.push('dispatch');return {state:'restored',items:[]};}},nativeHandoffRecovery:async scope=>{assert.equal(scope.parent,agent);assert.equal(scope.parentBinding,binding);calls.push('return');if(blocked)throw Error('private recovery detail');return {state:'returned',request_id:'original-return',revision:3};}};
 const handler=createAdapterHandler(options),request=(path,body)=>handler({method:'POST',url:new URL('http://127.0.0.1'+path),headers:{authorization:'Bearer '+'a'.repeat(32)},body}),body={session_id:'root',cwd:'/fixture',workbench_context:{run_id:'run'}};
 const restored=await request('/v1/sessions',body);assert.equal(restored.status,201);assert.deepEqual(calls,['attach','return','dispatch']);assert.equal(restored.value.native_handoff_recovery.state,'returned');
 calls.length=0;blocked=true;const pending=await request('/v1/sessions',body);assert.deepEqual(calls,['attach','return']);assert.deepEqual(pending.value.native_handoff_recovery,{state:'blocked'});assert.equal(JSON.stringify(pending).includes('private recovery detail'),false);
 assert.equal((await request('/v1/sessions/root/prompts',{request_id:'blocked-message',text:'continue'})).status,503);assert.equal(calls.includes('prompt'),false);
 blocked=false;assert.equal((await request('/v1/sessions',body)).value.native_handoff_recovery.state,'returned');assert.equal((await request('/v1/sessions/root/prompts',{request_id:'resumed-message',text:'continue'})).status,202);
});
test('formal Session attachment restores only the trusted task root and reports blocked recovery without hiding the original Session',async()=>{
 const agent={id:'root'},binding={runId:'run',sessionRef:'root'},calls=[];
 const bridge={request:async()=>({context:{}}),attach:async()=>calls.push('attach'),taskRootBindingFor:()=>binding,guard:async()=>{}};
 const scheduler={restore:async(a,b)=>{assert.equal(a,agent);assert.equal(b,binding);calls.push('restore');return {state:'restored',items:[]};}};
 const options={token:'a'.repeat(32),controller:{create:async()=>({session_id:'root'}),prompt:async()=>({accepted:true})},agents:{get:()=>agent},workbenchBridge:bridge,nativeTaskScheduler:scheduler};
 const request=(handler,path,body)=>handler({method:'POST',url:new URL('http://127.0.0.1'+path),headers:{authorization:'Bearer '+'a'.repeat(32)},body});
 const body={session_id:'root',cwd:'/fixture',workbench_context:{run_id:'run'}};
 const handler=createAdapterHandler(options),created=await request(handler,'/v1/sessions',body);assert.equal(created.status,201);assert.deepEqual(calls,['attach','restore']);assert.equal(created.value.native_dispatch_recovery.state,'restored');
 const blocked=createAdapterHandler({...options,nativeTaskScheduler:{restore:async()=>{throw Error('private failure details');}}});const failed=await request(blocked,'/v1/sessions',body);assert.equal(failed.status,201);assert.deepEqual(failed.value.native_dispatch_recovery,{state:'blocked'});assert.equal(JSON.stringify(failed).includes('private failure'),false);
 assert.equal((await request(blocked,'/v1/sessions/root/prompts',{request_id:'followup',text:'Resolve the pending task'})).status,202);
 calls.length=0;bridge.taskRootBindingFor=()=>undefined;assert.equal((await request(handler,'/v1/sessions',body)).status,201);assert.deepEqual(calls,['attach']);
});
test('dedicated budget preset requires a trusted role run and original lease before creating a Session',async()=>{
 let creates=0;const handler=createAdapterHandler({token:'a'.repeat(32),controller:{create:async()=>{creates++;return{};}},agents:{get:()=>({})},workbenchBridge:{request:async()=>({context:{}}),attach:async()=>{},guardBudget:async()=>{}},budgetModelSelector:async(_agent,check)=>check()});
 const request=body=>handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions'),headers:{authorization:'Bearer '+'a'.repeat(32)},body:{session_id:'session-fixture',cwd:'/fixture',agent_preset:'jot-workbench-budgeted',...body}});
 for(const body of [{},{workbench_context:{run_id:'run-fixture'}}])assert.equal((await request(body)).status,422);
 assert.equal(creates,0);assert.equal((await request({workbench_context:{run_id:'run-fixture',execution_lease:{owner:'worker-fixture',generation:1}}})).status,201);assert.equal(creates,1);
});


test('budget Session admission requires configured local selection and a live budget guard; failure blocks later prompts',async()=>{
 let creates=0,prompts=0,selections=0,checks=0;const body={session_id:'session-budget',cwd:'/fixture',agent_preset:'jot-workbench-budgeted',workbench_context:{run_id:'run-budget',execution_lease:{owner:'worker-fixture',generation:1}}};
 const controller={create:async()=>{creates++;return{};},prompt:async()=>{prompts++;return{};}};
 const options={token:'a'.repeat(32),controller,agents:{get:()=>({})},workbenchBridge:{request:async()=>({context:{}}),attach:async()=>{},guard:async()=>{},guardBudget:async()=>{checks++;}}};
 const request=(handler,path,payload)=>handler({method:'POST',url:new URL('http://127.0.0.1'+path),headers:{authorization:'Bearer '+'a'.repeat(32)},body:payload});
 const missing=createAdapterHandler(options);assert.equal((await request(missing,'/v1/sessions',body)).status,503);assert.equal(creates,0);
 const enabled=createAdapterHandler({...options,budgetModelSelector:async(agent,check)=>{await check();selections++;}});
 assert.equal((await request(enabled,'/v1/sessions',{...body,workbench_model:{provider:'forged',model:'forged'}})).status,201);assert.equal(selections,1);assert.equal(checks,1);
 const rejected=createAdapterHandler({...options,budgetModelSelector:async()=>{throw Error('model unavailable secret')}});
 assert.deepEqual(await request(rejected,'/v1/sessions',body),{status:503,value:{error:'workbench_bridge_unavailable'}});
 assert.equal((await request(rejected,'/v1/sessions/session-budget/prompts',{request_id:'request-1',text:'bypass'})).status,503);assert.equal(prompts,0);
});
