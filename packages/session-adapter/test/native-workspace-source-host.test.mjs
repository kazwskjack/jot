import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as sourceModule from '../native-workspace-source.js';
import {createNativeWorkspaceFactoryGate} from '../native-workspace-factory.js';

const scope={owner_id:'owner',project_id:'project',execution_id:'execution'};
function inventory(ids=['native']){
 const members=ids.map(session_ref=>({session_ref,scopes:[{conversation_id:'conversation',workspace_id:'workspace'}],source_kinds:['work_binding']}));
 const base={reservation_id:'reservation',owner_id:'owner',project_id:'project',binding_sha256:'b'.repeat(64),members:members.map(({session_ref,scopes})=>({session_ref,scopes}))};
 return{protocol:1,...base,execution_id:'execution',members,family_sha256:createHash('sha256').update(JSON.stringify(base)).digest('hex'),execution_authorized:false};
}
function fixture(){
 assert.equal(typeof sourceModule.createNativeWorkspaceSourceHost,'function');
 const held=new Set(),registry=new Map(),sessions=new Map(),header={id:'native',agentPreset:'jot-general',delegationDepth:0},events=[];
 const session={id:'native',header,seq:0,eventAt:i=>events[i]};
 const agent={id:'native',status:'idle',session,whenIdle:()=>assert.fail('maintenance must own idle'),runMaintenance:async job=>{held.add('native');try{return await job(new AbortController().signal);}finally{held.delete('native');}},
  ctx:{goals:{get:()=>undefined},tools:{guard:()=>()=>{}},on:()=>()=>{}}};
 registry.set('native',agent);sessions.set('native',session);
 class Backend{identity=Symbol('original-store');async flush(){};async open(id,access){return{id,access,header,read:async(offset,count)=>({events:events.slice(offset,offset+count)}),close:async()=>{}};}async stat(){return undefined;}}
 class Missing extends Error{}
 const persistence=new Backend(),hooks=new Map(),ctx={get:()=>({jotPreSetupHookProtocol:2}),on:(event,fn)=>{hooks.set(event,fn);return()=>hooks.delete(event);}};
 const gate=createNativeWorkspaceFactoryGate({ctx,registry,sessions,persistence,currentPersistence:()=>persistence,notFoundError:Missing});
 let valid=true,calls=0,reply=()=>inventory(),onRead=()=>{};
 const options={bridge:{origin:'http://127.0.0.1:7654',token:'test-source-token',fetch:async(_url,init)=>{calls++;assert.deepEqual(JSON.parse(init.body),scope);await onRead(calls);return Response.json({source:reply(calls)});}},
  registry,sessions,persistence,currentPersistence:()=>persistence,backendClass:Backend,allowedPresets:new Set(['jot-general']),validateLog:async()=>({validated:true}),
  projections:{stateOf:()=>({'next-turn':[],'next-step':[]})},factoryGate:gate};
 const host=sourceModule.createNativeWorkspaceSourceHost(options);
 return{host,options,held,registry,sessions,agent,gate,hooks,get calls(){return calls;},revoke:()=>{valid=false;},reply:fn=>{reply=fn;},onRead:fn=>{onRead=fn;},
  controls:{assertReservation:()=>{if(!valid)throw Error('original_reservation_revoked');}}};
}

test('source host derives exact original residents and holds them through awaited callback and final source read',async t=>{
 const f=fixture();t.after(()=>f.gate.dispose());
 f.onRead(n=>{if(n>1)assert.deepEqual([...f.held],['native']);});
 const result=await f.host.withReservedFamily(scope,f.controls,async({source,proofs,check,recheck,signal})=>{
  assert.equal(source.execution_authorized,false);assert.equal(Object.isFrozen(source),true);assert.deepEqual(proofs.map(p=>p.session_ref),['native']);
  assert.equal(signal.aborted,false);check();await recheck();assert.deepEqual([...f.held],['native']);return 'observed';
 });
 assert.equal(result,'observed');assert.equal(f.calls,4);assert.equal(f.held.size,0);
});

test('a caller cannot select another member, root or dispatch grant',async t=>{
 const f=fixture();t.after(()=>f.gate.dispose());
 for(const extra of [{members:[]},{root:'untrusted'},{dispatch:true}])await assert.rejects(f.host.withReservedFamily({...scope,...extra},f.controls,()=>assert.fail('no callback')),/native_workspace_source_invalid/);
 assert.equal(f.calls,0);
});

test('fresh source disagreement unwinds native custody before callback',async t=>{
 const f=fixture();t.after(()=>f.gate.dispose());f.reply(n=>n===1?inventory():inventory(['other']));
 await assert.rejects(f.host.withReservedFamily(scope,f.controls,()=>assert.fail('no callback')),/native_workspace_source_changed/);
 assert.equal(f.held.size,0);
});

test('post-callback source revocation is not retried or reported as no effect',async t=>{
 const f=fixture();t.after(()=>f.gate.dispose());let effects=0;
 f.reply(n=>{const s=inventory();if(n===3)s.binding_sha256='c'.repeat(64);return s;});
 await assert.rejects(f.host.withReservedFamily(scope,f.controls,async()=>{effects++;}),/native_workspace_source_unconfirmed/);
 assert.equal(effects,1);assert.equal(f.calls,3);assert.equal(f.held.size,0);
});

test('original synchronous reservation revocation across source await prevents callback',async t=>{
 const f=fixture();t.after(()=>f.gate.dispose());f.onRead(n=>{if(n===2)f.revoke();});
 await assert.rejects(f.host.withReservedFamily(scope,f.controls,()=>assert.fail('no callback')),/original_reservation_revoked/);
 assert.equal(f.held.size,0);
});

test('async reservation checks and body-supplied runtime dependencies are refused',async t=>{
 const f=fixture();t.after(()=>f.gate.dispose());
 await assert.rejects(f.host.withReservedFamily(scope,{assertReservation:async()=>{}},()=>assert.fail('no callback')),/native_workspace_reservation_invalid/);
 await assert.rejects(f.host.withReservedFamily(scope,{...f.controls,registry:new Map()},()=>assert.fail('no callback')),/native_workspace_host_controls_invalid/);
 assert.equal(f.calls,0);
});

test('host captures original service and callback identities before caller mutation',async t=>{
 const f=fixture();t.after(()=>f.gate.dispose());const controls={...f.controls},request={...scope};
 f.onRead(n=>{if(n===1){request.owner_id='foreign';controls.assertReservation=()=>{};f.options.registry=new Map();f.options.bridge.fetch=()=>assert.fail('must retain original source transport');}});
 await assert.rejects(f.host.withReservedFamily(request,controls,async()=>{f.revoke();}),/original_reservation_revoked/);
 assert.equal(f.held.size,0);
});

test('a resident from another preset cannot borrow an original source identity',async t=>{
 const f=fixture();t.after(()=>f.gate.dispose());f.agent.session.header.agentPreset='unconfigured';
 await assert.rejects(f.host.withReservedFamily(scope,f.controls,()=>assert.fail('no callback')),/native_workspace_source_member_changed/);
 assert.equal(f.held.size,0);
});

test('request cancellation during source reading and callback failure preserve custody cleanup',async t=>{
 const f=fixture();t.after(()=>f.gate.dispose());const abort=new AbortController();f.onRead(n=>{if(n===2)abort.abort();});
 await assert.rejects(f.host.withReservedFamily(scope,{...f.controls,signal:abort.signal},()=>assert.fail('no callback')),{name:'AbortError'});
 assert.equal(f.held.size,0);
 f.onRead(()=>{});const error=Error('original_effect_failure');
 await assert.rejects(f.host.withReservedFamily(scope,f.controls,()=>{throw error;}),e=>e===error);
 assert.equal(f.held.size,0);
});

test('only a currently held original source context exposes native working-directory observations',async t=>{
 const f=fixture();t.after(()=>f.gate.dispose());f.agent.session.header.cwd='/original/project';let retained;
 assert.equal(typeof sourceModule.inspectNativeWorkspaceSource,'function');
 await f.host.withReservedFamily(scope,f.controls,async context=>{
  retained=context;const view=sourceModule.inspectNativeWorkspaceSource(context);
  assert.equal(view.source.execution_id,scope.execution_id);assert.equal(view.execution_authorized,false);assert.equal(view.signal,context.signal);
  assert.deepEqual(view.workspaces.map(({session_ref,custody,cwd})=>({session_ref,custody,cwd})),[{session_ref:'native',custody:'resident',cwd:'/original/project'}]);
  assert.equal(Object.isFrozen(view.workspaces[0]),true);assert.equal(Object.isFrozen(view),true);
  assert.throws(()=>sourceModule.inspectNativeWorkspaceSource({...context}),/native_workspace_source_context_invalid/);
  assert.throws(()=>sourceModule.inspectNativeWorkspaceSource(JSON.parse(JSON.stringify(context))),/native_workspace_source_context_invalid/);
  assert.throws(()=>sourceModule.assertNativeWorkspaceSourceAdmission(context),/native_workspace_admission_unavailable/,'read-only host custody is not proof of pre-storage startup admission');
  await context.recheck();assert.equal(sourceModule.inspectNativeWorkspaceSource(context),view);
 });
 assert.throws(()=>sourceModule.inspectNativeWorkspaceSource(retained),/native_workspace_source_context_invalid/);
 assert.throws(()=>retained.check(),/native_workspace_source_context_invalid/);
 await assert.rejects(retained.recheck(),/native_workspace_source_context_invalid/);assert.equal(f.held.size,0);
});

test('source-context observation rechecks original authority and native header, and revokes on callback failure',async t=>{
 const f=fixture();t.after(()=>f.gate.dispose());let retained;
 assert.equal(typeof sourceModule.inspectNativeWorkspaceSource,'function');
 await assert.rejects(f.host.withReservedFamily(scope,f.controls,async context=>{
  retained=context;f.agent.session.header.cwd='/changed';
  sourceModule.inspectNativeWorkspaceSource(context);
 }),/native_handoff_changed/);
 assert.throws(()=>sourceModule.inspectNativeWorkspaceSource(retained),/native_workspace_source_context_invalid/);assert.equal(f.held.size,0);
 const second=fixture();t.after(()=>second.gate.dispose());
 await assert.rejects(second.host.withReservedFamily(scope,second.controls,async context=>{second.revoke();sourceModule.inspectNativeWorkspaceSource(context);}),/original_reservation_revoked/);
});
