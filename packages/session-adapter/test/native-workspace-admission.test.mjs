import test from 'node:test';import assert from 'node:assert/strict';
import {WorkbenchBridge} from '../workbench.js';
import * as factory from '../native-workspace-factory.js';
import {apply} from '../index.js';
const token='test-native-admission-token';
function fixture(fetchImpl=async()=>Response.json({protocol:1,session_ref:'native',execution_authorized:false})){
 const hooks=new Map(),ctx={get:()=>({jotPreSetupHookProtocol:2,jotStorageAdmissionHookProtocol:1,config:{agents:[]}}),agents:{list:()=>[]},on:(event,fn)=>{hooks.set(event,fn);return()=>hooks.delete(event);}};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token,fetchImpl});
 assert.equal(typeof factory.createNativeWorkspaceAdmissionGate,'function');
 const gate=factory.createNativeWorkspaceAdmissionGate({ctx,bridge});return{hooks,ctx,bridge,gate};
}
test('original before and after setup each require a fresh authenticated negative-fence observation',async()=>{
 let calls=0;const f=fixture(async(url,request)=>{calls++;assert.equal(url,'http://127.0.0.1:7654/internal/v1/workbench/native-workspace-admission');
  assert.deepEqual(JSON.parse(request.body),{session_ref:'native'});assert.equal(request.headers.authorization,'Bearer '+token);
  return Response.json({protocol:1,session_ref:'native',execution_authorized:false});});
 try{for(const event of ['agent/before-setup','agent/after-setup'])await f.hooks.get(event)({agent:{id:'native'},signal:new AbortController().signal});assert.equal(calls,2);}
 finally{await f.gate.dispose();}assert.equal(f.hooks.size,0);
});
test('held, offline and malformed observations reject setup instead of reusing an old success',async()=>{
 let mode='ok',calls=0;const f=fixture(async()=>{calls++;if(mode==='offline')throw Error('sensitive transport detail');if(mode==='held')return new Response('',{status:409});
  return Response.json(mode==='malformed'?{protocol:1,session_ref:'other',execution_authorized:true}:{protocol:1,session_ref:'native',execution_authorized:false});});
 try{
  const setup=()=>f.hooks.get('agent/before-setup')({agent:{id:'native'}});await setup();
  for(mode of ['held','offline','malformed'])await assert.rejects(setup(),/native_workspace_admission_unconfirmed/);
  mode='ok';await setup();assert.equal(calls,5);
 }finally{await f.gate.dispose();}
});
test('shutdown cancels in-flight observations and drains before removing the original hooks',async()=>{
 let entered;const ready=new Promise(resolve=>{entered=resolve;});
 const f=fixture(async(_url,request)=>{entered();return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));});
 const pending=f.hooks.get('agent/before-setup')({agent:{id:'native'}});pending.catch(()=>{});await ready;
 const disposal=f.gate.dispose();assert.equal(f.hooks.size,3);await assert.rejects(pending);await disposal;assert.equal(f.hooks.size,0);
});
test('unpatched runtimes and request-side namespace selectors cannot install or use the guard',async()=>{
 const f=fixture();try{
  assert.throws(()=>factory.createNativeWorkspaceAdmissionGate({ctx:{...f.ctx,get:()=>({})},bridge:f.bridge}),/native_workspace_admission_unavailable/);
  await assert.rejects(f.bridge.nativeAdmission({session_ref:'native',root:'untrusted'}),/native_workspace_admission_invalid/);
 }finally{await f.gate.dispose();}
});

test('original adapter rejects unsupported admission configuration before opening its server',()=>{
 const name='JOT_NATIVE_ADMISSION_TEST_TOKEN',internal='JOT_NATIVE_ADMISSION_TEST_INTERNAL',old=process.env[name],previous=process.env[internal];
 process.env[name]='a'.repeat(32);delete process.env[internal];
 try{
  const config={tokenEnv:name,workbenchTokenEnv:internal},ctx=Object.defineProperty({},'sessionController',{get(){throw Error('controller_must_not_be_reached');}});
  for(const nativeWorkspaceAdmission of ['yes',true])assert.throws(()=>apply(ctx,{...config,nativeWorkspaceAdmission}),/jot_session_adapter_config_invalid/);
  process.env[internal]='test-native-admission-token';
  assert.throws(()=>apply(ctx,{...config,nativeWorkspaceAdmission:true}),/native_workspace_admission_unavailable/);
 }finally{if(old===undefined)delete process.env[name];else process.env[name]=old;if(previous===undefined)delete process.env[internal];else process.env[internal]=previous;}
});

test('admission must mount before eager configured startup or any pre-existing resident',async()=>{
 const f=fixture();try{
  assert.throws(()=>factory.createNativeWorkspaceAdmissionGate({ctx:{...f.ctx,get:()=>({jotPreSetupHookProtocol:2,jotStorageAdmissionHookProtocol:1,config:{agents:[{id:'eager'}]}})},bridge:f.bridge}),/native_workspace_admission_unavailable/);
  assert.throws(()=>factory.createNativeWorkspaceAdmissionGate({ctx:{...f.ctx,agents:{list:()=>[{id:'resident'}]}},bridge:f.bridge}),/native_workspace_admission_unavailable/);
 }finally{await f.gate.dispose();}
});

test('physical custody requires live startup admission and a factory from the same original Host',async()=>{
 const f=fixture(),other=fixture(),persistence={identity:Symbol('original-store')};class Missing extends Error{}
 const gate=factory.createNativeWorkspaceFactoryGate({ctx:f.ctx,registry:{get:()=>undefined},sessions:{get:()=>undefined},persistence,currentPersistence:()=>persistence,notFoundError:Missing});
 try{
  assert.equal(factory.assertNativeWorkspaceAdmissionGate(f.gate,gate),undefined);
  for(const candidate of [{...f.gate},other.gate,undefined])assert.throws(()=>factory.assertNativeWorkspaceAdmissionGate(candidate,gate),/native_workspace_admission_unavailable/);
  assert.throws(()=>factory.assertNativeWorkspaceAdmissionGate(f.gate,{...gate}),/native_workspace_admission_unavailable/);
  await f.gate.dispose();assert.throws(()=>factory.assertNativeWorkspaceAdmissionGate(f.gate,gate),/native_workspace_admission_unavailable/);
 }finally{await gate.dispose();await f.gate.dispose();await other.gate.dispose();}
});
