import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeWorkspaceFactoryGate,assertNativeWorkspaceFactoryHold} from '../native-workspace-factory.js';
function fixture(){
 const hooks=new Map(),registry={get:()=>undefined},sessions={get:()=>undefined},persistence={identity:Symbol('storage')};
 class Missing extends Error{constructor(id){super('missing');this.sessionId=id;}}
 const ctx={get:()=>({jotPreSetupHookProtocol:2}),on:(event,fn)=>{hooks.set(event,fn);return()=>hooks.delete(event);}};
 return{hooks,registry,sessions,persistence,Missing,options:{ctx,registry,sessions,persistence,currentPersistence:()=>persistence,notFoundError:Missing}};
}
test('factory claim denies setup and publication for exactly the original held identities',async()=>{
 const f=fixture(),gate=createNativeWorkspaceFactoryGate(f.options),lease=gate.claim(['cold','lead']);
 for(const event of ['agent/before-setup','agent/after-setup','agent/created']){
  assert.throws(()=>f.hooks.get(event)({agent:{id:'cold'}}),/native_workspace_factory_fenced/);
  assert.doesNotThrow(()=>f.hooks.get(event)({agent:{id:'other'}}));
 }
 assert.equal(assertNativeWorkspaceFactoryHold(lease.token,{sessionRef:'cold',registry:f.registry,sessions:f.sessions,persistence:f.persistence}).notFoundError,f.Missing);
 assert.throws(()=>gate.claim(['cold']),/native_workspace_factory_busy/);
 lease.release();lease.release();assert.doesNotThrow(()=>f.hooks.get('agent/before-setup')({agent:{id:'cold'}}));await gate.dispose();assert.equal(f.hooks.size,0);
});
test('a serializable fake token, another member or another service is never factory authority',async()=>{
 const f=fixture(),gate=createNativeWorkspaceFactoryGate(f.options),lease=gate.claim(['cold']);
 for(const [token,scope]of [[{},{}],[lease.token,{sessionRef:'other'}],[lease.token,{sessionRef:'cold',persistence:{}}]])
  assert.throws(()=>assertNativeWorkspaceFactoryHold(token,{sessionRef:'cold',registry:f.registry,sessions:f.sessions,persistence:f.persistence,...scope}),/native_workspace_factory_hold_invalid/);
 lease.release();assert.throws(()=>assertNativeWorkspaceFactoryHold(lease.token,{sessionRef:'cold',registry:f.registry,sessions:f.sessions,persistence:f.persistence}),/native_workspace_factory_hold_invalid/);await gate.dispose();
});
test('shutdown cancels active claims and keeps namespace hooks until the holder drains',async()=>{
 const f=fixture(),gate=createNativeWorkspaceFactoryGate(f.options),lease=gate.claim(['cold']);let done=false;
 const disposed=gate.dispose().then(()=>{done=true;});assert.equal(lease.signal.aborted,true);await Promise.resolve();assert.equal(done,false);assert.equal(f.hooks.size,3);
 assert.throws(()=>gate.claim(['other']),/native_workspace_factory_inactive/);lease.release();await disposed;assert.equal(f.hooks.size,0);
});
test('an unpatched factory cannot advertise the exclusion primitive',()=>{
 const f=fixture();assert.throws(()=>createNativeWorkspaceFactoryGate({...f.options,ctx:{...f.options.ctx,get:()=>({})}}),/native_workspace_factory_unavailable/);
});
