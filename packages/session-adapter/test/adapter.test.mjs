import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createAdapterHandler, apply } from '../index.js'

const token = 'a'.repeat(32)
function fixture() {
  const calls = []
  const handler = createAdapterHandler({ token, controller: {
    create: async request => { calls.push(request); return { sessionId: request.sessionId } },
  } })
  const invoke = cwd => handler({ method: 'POST', url: new URL('http://127.0.0.1/v1/sessions'),
    headers: { authorization: `Bearer ${token}` }, body: { session_id: 'path-probe', cwd } })
  return { calls, invoke }
}

test('Session creation preserves a host-native absolute workspace path', async () => {
  const { calls, invoke } = fixture()
  const cwd = path.resolve('workspace-fixture')
  assert.equal((await invoke(cwd)).status, 201)
  assert.deepEqual(calls, [{ sessionId: 'path-probe', cwd }])
})

test('Session creation rejects relative, drive-relative, malformed and non-string paths before Controller dispatch', async () => {
  for (const cwd of ['workspace', '../workspace', 'E:workspace', '', '/workspace\u0000hidden', ['/workspace'], { path: '/workspace' }]) {
    const { calls, invoke } = fixture()
    assert.equal((await invoke(cwd)).status, 422)
    assert.deepEqual(calls, [])
  }
})

test('documented public presets reach the original Controller without name translation', async () => {
  for (const agentPreset of ['jot-general', 'jot-general-batch50', 'jot-general-batch']) {
    const calls = []
    const handler = createAdapterHandler({ token, controller: { create: async request => {
      calls.push(request); return { sessionId: request.sessionId, agentPreset: request.agentPreset }
    } } })
    const response = await handler({ method: 'POST', url: new URL('http://127.0.0.1/v1/sessions'),
      headers: { authorization: `Bearer ${token}` }, body: { session_id: 'preset-probe', cwd: path.resolve('workspace-fixture'), agent_preset: agentPreset } })
    assert.equal(response.status, 201)
    assert.equal(calls[0].agentPreset, agentPreset)
    assert.equal(response.value.agentPreset, agentPreset)
  }
})

test('unknown preset is rejected before Controller admission', async () => {
  let invoked = false
  const handler = createAdapterHandler({ token, controller: { create: async () => { invoked = true } } })
  const response = await handler({ method: 'POST', url: new URL('http://127.0.0.1/v1/sessions'),
    headers: { authorization: `Bearer ${token}` }, body: { session_id: 'preset-probe', cwd: path.resolve('workspace-fixture'), agent_preset: 'not-registered' } })
  assert.equal(response.status, 422)
  assert.equal(invoked, false)
})

test('the documented default token environment admits host setup without opening a listener in this test', () => {
  const prior = process.env.JOT_SESSION_ADAPTER_TOKEN
  const legacy = process.env.jot_SESSION_ADAPTER_TOKEN
  try {
    delete process.env.jot_SESSION_ADAPTER_TOKEN
    // Windows environment names are case-insensitive; delete before assigning.
    process.env.JOT_SESSION_ADAPTER_TOKEN = token
    const ctx = Object.defineProperty({}, 'sessionController', { get() { throw new Error('original_controller_setup_reached') } })
    assert.throws(() => apply(ctx), /original_controller_setup_reached/)
  } finally {
    if (prior === undefined) delete process.env.JOT_SESSION_ADAPTER_TOKEN
    else process.env.JOT_SESSION_ADAPTER_TOKEN = prior
    if (legacy === undefined) delete process.env.jot_SESSION_ADAPTER_TOKEN
    else process.env.jot_SESSION_ADAPTER_TOKEN = legacy
  }
})

test('formal setup rejects malformed operation observers and observers without native roles',()=>{
 const prior=process.env.JOT_SESSION_ADAPTER_TOKEN;process.env.JOT_SESSION_ADAPTER_TOKEN=token;
 try{
  const ctx=Object.defineProperty({},'sessionController',{get(){throw Error('controller_must_not_be_reached');}});
  for(const reconcileOperations of [{},async()=>{}])assert.throws(()=>apply(ctx,{reconcileOperations}),/jot_session_adapter_config_invalid/);
 }finally{if(prior===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=prior;}
});

test('formal setup rejects native operation origins without native roles',()=>{
 const prior=process.env.JOT_SESSION_ADAPTER_TOKEN;process.env.JOT_SESSION_ADAPTER_TOKEN=token;
 try{const ctx=Object.defineProperty({},'sessionController',{get(){throw Error('controller_must_not_be_reached');}});assert.throws(()=>apply(ctx,{nativeOperationOrigin:'http://localhost:18792'}),/jot_session_adapter_config_invalid/);}
 finally{if(prior===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=prior;}
});

test('formal handoff admission requires a trusted function and native roles',()=>{
 const prior=process.env.JOT_SESSION_ADAPTER_TOKEN;process.env.JOT_SESSION_ADAPTER_TOKEN=token;
 try{const ctx=Object.defineProperty({},'sessionController',{get(){throw Error('controller_must_not_be_reached');}});for(const handoffAdmission of [{},async()=>{}])assert.throws(()=>apply(ctx,{handoffAdmission}),/jot_session_adapter_config_invalid/);}
 finally{if(prior===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=prior;}
});

test('deferred handoff scheduling requires native roles and a trusted admission entry',()=>{
 const prior=process.env.JOT_SESSION_ADAPTER_TOKEN;process.env.JOT_SESSION_ADAPTER_TOKEN=token;
 try{const ctx=Object.defineProperty({},'sessionController',{get(){throw Error('controller_must_not_be_reached');}});for(const nativeDeferredHandoff of [true,'yes'])assert.throws(()=>apply(ctx,{nativeDeferredHandoff}),/jot_session_adapter_config_invalid/);}
 finally{if(prior===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=prior;}
});

test('automatic final return requires a trusted callback and native handoff admission',()=>{
 const prior=process.env.JOT_SESSION_ADAPTER_TOKEN;process.env.JOT_SESSION_ADAPTER_TOKEN=token;
 try{const ctx=Object.defineProperty({},'sessionController',{get(){throw Error('controller_must_not_be_reached');}});for(const handoffReturn of [{},async()=>{}])assert.throws(()=>apply(ctx,{handoffReturn}),/jot_session_adapter_config_invalid/);}
 finally{if(prior===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=prior;}
});

test('durable final-return recovery requires trusted native handoff configuration',()=>{
 const prior=process.env.JOT_SESSION_ADAPTER_TOKEN;process.env.JOT_SESSION_ADAPTER_TOKEN=token;
 try{const ctx=Object.defineProperty({},'sessionController',{get(){throw Error('controller_must_not_be_reached');}});for(const handoffRecovery of [{},async()=>{}])assert.throws(()=>apply(ctx,{handoffRecovery}),/jot_session_adapter_config_invalid/);}
 finally{if(prior===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=prior;}
});

test('trusted native handoff rejects malformed configuration and all manual callback mixing',()=>{
 const priorToken=process.env.JOT_SESSION_ADAPTER_TOKEN,priorBridge=process.env.JOT_NATIVE_HANDOFF_CONFIG_TEST;
 process.env.JOT_SESSION_ADAPTER_TOKEN=token;process.env.JOT_NATIVE_HANDOFF_CONFIG_TEST='b'.repeat(32);
 try{
  const ctx=Object.defineProperty({},'sessionController',{get(){throw Error('controller_must_not_be_reached');}});
  const roleConfig={nativeContinuation:true,nativeRoles:true,workbenchModel:{provider:'fixture',model:'bounded'},workbenchTokenEnv:'JOT_NATIVE_HANDOFF_CONFIG_TEST'};
  const valid={policyVersion:1,maxHops:2,validateLog:async()=>({validated:true})};
  for(const nativeHandoff of [null,[],{},
   {policyVersion:0,maxHops:2,validateLog:valid.validateLog},
   {policyVersion:1,maxHops:0,validateLog:valid.validateLog},
   {policyVersion:1,maxHops:21,validateLog:valid.validateLog},
   {policyVersion:1,maxHops:2,validateLog:{}},
   {...valid,unexpected:true}]){
   assert.throws(()=>apply(ctx,{...roleConfig,nativeHandoff}),/jot_session_adapter_config_invalid/);
  }
  assert.throws(()=>apply(ctx,{...roleConfig,nativeHandoff:valid,nativeRoles:false}),/jot_session_adapter_config_invalid/);
  for(const manual of [
   {handoffAdmission:async()=>{}},
   {handoffAdmission:async()=>{},handoffReturn:async()=>{}},
   {handoffAdmission:async()=>{},handoffRecovery:async()=>{}},
  ])assert.throws(()=>apply(ctx,{...roleConfig,nativeHandoff:valid,...manual}),/jot_session_adapter_config_invalid/);
 }finally{
  if(priorToken===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=priorToken;
  if(priorBridge===undefined)delete process.env.JOT_NATIVE_HANDOFF_CONFIG_TEST;else process.env.JOT_NATIVE_HANDOFF_CONFIG_TEST=priorBridge;
 }
});

test('nativeDeferredHandoff accepts the trusted nativeHandoff composition without manual callbacks',()=>{
 const priorToken=process.env.JOT_SESSION_ADAPTER_TOKEN,priorBridge=process.env.JOT_NATIVE_HANDOFF_CONFIG_TEST;
 process.env.JOT_SESSION_ADAPTER_TOKEN=token;process.env.JOT_NATIVE_HANDOFF_CONFIG_TEST='b'.repeat(32);
 try{
  const ctx=Object.defineProperty({},'sessionController',{get(){throw Error('native_handoff_config_accepted');}});
  assert.throws(()=>apply(ctx,{
   nativeContinuation:true,nativeRoles:true,nativeDeferredHandoff:true,
   workbenchModel:{provider:'fixture',model:'bounded'},workbenchTokenEnv:'JOT_NATIVE_HANDOFF_CONFIG_TEST',
   nativeHandoff:{policyVersion:1,maxHops:2,validateLog:async()=>({validated:true})},
  }),/native_handoff_config_accepted/);
 }finally{
  if(priorToken===undefined)delete process.env.JOT_SESSION_ADAPTER_TOKEN;else process.env.JOT_SESSION_ADAPTER_TOKEN=priorToken;
  if(priorBridge===undefined)delete process.env.JOT_NATIVE_HANDOFF_CONFIG_TEST;else process.env.JOT_NATIVE_HANDOFF_CONFIG_TEST=priorBridge;
 }
});


test('memory extraction endpoint uses only its existing bound Session and propagates cancellation',async()=>{
 const agent={id:'extract-session',status:'idle'},binding={runId:'extract-run',sessionRef:'extract-session',executionLease:{owner:'worker',generation:1}},controller=new AbortController();let calls=0;
 const handler=createAdapterHandler({token,controller:{},agents:{get:id=>id===agent.id?agent:null},workbenchBridge:{bindingFor:target=>target===agent?binding:null},memoryExtractionHost:{run:async(target,options)=>{calls++;assert.equal(target,agent);assert.equal(options.signal,controller.signal);return {capture_id:'capture',version:3,status:'proposed'};}}});
 const invoke=(body,auth=`Bearer ${token}`)=>handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions/extract-session/memory-extraction'),headers:{authorization:auth},body,signal:controller.signal});
 assert.equal((await invoke({run_id:'extract-run'},'Bearer invalid')).status,401);
 assert.equal((await invoke({run_id:'extract-run',source_text:'Injected'})).status,422);
 assert.equal((await invoke({run_id:'other-run'})).status,409);assert.equal(calls,0);
 const result=await invoke({run_id:'extract-run'});assert.equal(result.status,200);assert.equal(result.value.status,'proposed');assert.equal(calls,1);
});


test('trusted extraction purpose skips task-input recovery without skipping original Session or budget attachment',async()=>{
 const agent={id:'extract-session'},binding={runId:'extract-run',sessionRef:'extract-session',executionLease:{owner:'worker',generation:1}};let attached=0,selected=0,created=0;
 const bridge={async request(){return {context:{kind:'memory_capture'}};},async attach(){attached++;},async guardBudget(){}};
 const handler=createAdapterHandler({token,controller:{async create(){created++;return {sessionId:agent.id};}},agents:{get:()=>agent},workbenchBridge:bridge,budgetModelSelector:async()=>{selected++;},nativeClaimedComposer:{async withCreation(){throw Error('task_composer_must_not_run');}},memoryExtractionHost:{async readiness(){return {ready:true};}}});
 const result=await handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions'),headers:{authorization:`Bearer ${token}`},body:{session_id:agent.id,cwd:path.resolve('.test-tmp/extraction-workspace'),agent_preset:'jot-workbench-budgeted',workbench_context:{run_id:binding.runId,execution_lease:binding.executionLease}}});
 assert.equal(result.status,201);assert.equal(created,1);assert.equal(attached,1);assert.equal(selected,1);
});
