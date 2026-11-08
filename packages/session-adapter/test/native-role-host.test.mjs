import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNativeRoleHost} from '../native-role-host.js';
import {createAdapterHandler} from '../index.js';
const token='t'.repeat(32);const invoke=(handler,path,body={},authorized=true)=>handler({method:'POST',url:new URL('http://127.0.0.1'+path),headers:authorized?{authorization:`Bearer ${token}`}:{},body,signal:new AbortController().signal});
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function fixture(options={}){const {drainApi='legacy',onDrain,...hostOptions}=options;const entries=new Map(),owners=new Map(),bindings=new WeakMap(),events=[],hooks=new Map();let provider,counter=0;
 const make=(id,parent)=>{const barriers=new Map(),agent={id,session:{id,header:parent?{parentSession:parent.id}:{}},ctx:{tools:{guard:fn=>{barriers.set('tool',fn);return()=>barriers.delete('tool');}},on:(name,fn)=>{barriers.set(name,fn);return()=>barriers.delete(name);}},barriers};entries.set(id,agent);if(parent)owners.set(id,parent);return agent;};
 const root=make('root');bindings.set(root,Object.freeze({runId:'root-run',sessionRef:'root',executionLease:{owner:'worker',generation:1}}));
 const bridge={bindingFor:a=>bindings.get(a),guardBudget:async a=>{assert.ok(bindings.get(a));},attach:async(a,b)=>{events.push('attach');bindings.set(a,Object.freeze({...b}));},request:async(path,b,p)=>{assert.equal(b.sessionRef,'root');events.push(path);if(path==='native-child-reservation')return {reservation:{reservation_id:'reservation-'+p.child_session_ref,child_session_ref:p.child_session_ref,role_id:p.role_ref}};return {binding:{runId:'run-'+p.reservation_id,sessionRef:p.reservation_id.replace('reservation-',''),executionLease:{owner:'worker',generation:1}}};}};
 const subagents={registerProvider:p=>{provider=p;return()=>{provider=undefined;};}};let drain=onDrain??(async()=>{});
 const exposeDrain=name=>Object.defineProperty(subagents,name,{configurable:true,get(){return function(...args){return drain.apply(this,args);};},set(next){drain=next;}});
 if(drainApi==='legacy')exposeDrain('drainContinuableChildren');
 if(drainApi==='modern')exposeDrain('drainChildren');
 const ctx={agents:{get:id=>entries.get(id),list:()=>[...entries.values()],isOwnedBy:(id,p)=>owners.get(id)===p},on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name);},subagents,agentTeams:{spawnTeammate:async(parent,request)=>{assert.equal(request.provider,'jot-native-role');const id='child-'+(++counter);await provider.prepareContinuable({parent,sessionId:id,signal:request.signal});const child=make(id,parent);await hooks.get('agent/created')({agent:child,signal:request.signal});events.push('published');return {member:{id}};}}};
 const selectModel=async(child,check)=>{assert.equal(child.barriers.get('tool')(),'NATIVE_CHILD_NOT_ADMITTED');await check();events.push('select');};
 const host=createNativeRoleHost({ctx,bridge,selectModel,...hostOptions});const request={name:'Saved role',description:'Review',prompt:[{type:'text',text:'Review evidence'}],context:'fresh',signal:new AbortController().signal};
 return {host,ctx,root,bridge,events,bindings,entries,request,hooks,make};}
for(const drainApi of ['modern','legacy'])test(`${drainApi} child drain API preserves its receiver during close and disposal`,async()=>{
 const calls=[],events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'turn/end',data:{}}];let child;
 const f=fixture({drainApi,onDrain(parent,ids){assert.equal(this,f.ctx.subagents);calls.push([parent,ids]);for(const id of ids)f.entries.delete(id);},persistence:{flush:async()=>{},open:async()=>({id:child.id,access:'read',header:child.session.header,read:async(offset,count)=>({events:events.slice(offset,offset+count)}),close:async()=>{}})}});
 f.ctx.sessionProjections={stateOf:()=>({'next-turn':[],'next-step':[]})};
 const result=await f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request);
 child=f.entries.get(result.member.id);child.status='idle';child.whenIdle=async()=>{};Object.assign(child.session,{seq:2,eventAt:i=>events[i]});
 const request=f.bridge.request;f.bridge.request=async(path,b,payload)=>path==='native-child-close'?{closed:true,run_id:b.runId}:request(path,b,payload);
 await f.host.closeMember(f.root,child.id);
 await f.host.dispose();
 assert.deepEqual(calls,[[f.root,[result.member.id]],[f.root,[result.member.id]]]);
});
test('host fails closed when neither supported child drain API exists',()=>{
 assert.throws(()=>fixture({drainApi:'neither'}),/native_role_host_incompatible/);
});
test('named provider prepares backend identity, attaches a cloned binding and selects model before native publication',async()=>{const f=fixture();const result=await f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request);assert.equal(result.member.id,'child-1');assert.deepEqual(f.events,['native-child-reservation','native-child-bind','attach','select','published']);assert.equal(f.entries.get('child-1').barriers.size,0);await f.host.dispose();});

test('provider prepare failure reports its original identity before native creation even after user cancellation',async()=>{
 const f=fixture(),original=f.bridge.request,controller=new AbortController(),calls=[];
 f.bridge.request=async(path,binding,payload,signal)=>{if(path==='native-child-bind'){controller.abort();throw Error('bind unavailable');}if(path==='native-child-abort'){calls.push({binding,payload,aborted:signal.aborted});return {aborted:true,child_session_ref:payload.child_session_ref};}return original(path,binding,payload,signal);};
 await assert.rejects(f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},{...f.request,signal:controller.signal}),error=>error.message==='bind unavailable'&&error.nativeCreationRecovery.status==='aborted');
 assert.equal(calls.length,1);assert.equal(calls[0].binding,f.bridge.bindingFor(f.root));assert.equal(calls[0].payload.child_session_ref,'child-1');assert.equal(calls[0].payload.request_id,'request');assert.deepEqual(calls[0].payload.proof,{protocol:1,phase:'provider_prepare_failed'});assert.equal(calls[0].aborted,false);assert.equal(f.entries.size,1);await f.host.dispose();
});

test('an abort cleanup refusal never hides the original prepare error or creates a child',async()=>{
 const f=fixture(),original=f.bridge.request;let attempts=0;
 f.bridge.request=async(path,binding,payload,signal)=>{if(path==='native-child-bind')throw Error('original preparation failure');if(path==='native-child-abort'){attempts++;throw Error('native_creation_outcome_unknown');}return original(path,binding,payload,signal);};
 await assert.rejects(f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request),error=>error.message==='original preparation failure'&&error.nativeCreationRecovery.status==='bound_outcome_unknown');assert.equal(attempts,1);assert.equal(f.entries.size,1);await f.host.dispose();
});

test('disposal drains one bounded pre-create cleanup before removing native admission',async()=>{
 const f=fixture(),original=f.bridge.request;let entered,release,aborts=0;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 f.bridge.request=async(path,binding,payload,signal)=>{if(path==='native-child-bind'){entered();await gate;throw Error('bind interrupted');}if(path==='native-child-abort'){assert.equal(signal.aborted,false);aborts++;return {aborted:true,child_session_ref:payload.child_session_ref};}return original(path,binding,payload,signal);};
 const pending=f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'shutdown-prepare'},f.request);await started;const stopping=f.host.dispose();release();await assert.rejects(pending,error=>error.message==='bind interrupted'&&error.nativeCreationRecovery.status==='aborted');await stopping;assert.equal(aborts,1);assert.equal(f.entries.size,1);
});

test('a durable aborted reservation is terminal and cannot create or recover a member',async()=>{
 const f=fixture({durableSpawns:true});f.bridge.request=async()=>({reservation:{child_session_ref:'original-child',aborted:true}});
 await assert.rejects(f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request),/native_role_creation_aborted/);assert.equal(f.entries.size,1);await f.host.dispose();
});

test('host awaits exact handoff admission before selecting a member model or publishing it',async()=>{
 let entered,release;const ready=new Promise(done=>entered=done),gate=new Promise(done=>release=done);
 const f=fixture({handoffAdmission:async({parent,child,roleRef,binding,parentBinding})=>{
  assert.equal(parent,f.root);assert.equal(roleRef,'role');assert.equal(parentBinding,f.bridge.bindingFor(parent));
  assert.equal(Object.isFrozen(binding),true);assert.equal(Object.isFrozen(binding.executionLease),true);
  assert.equal(child.barriers.get('tool')(),'NATIVE_CHILD_NOT_ADMITTED');entered();await gate;
  return {state:{revision:2,controller:roleRef,phase:'active'},binding:{revision:2,run_id:binding.runId,session_ref:child.id}};
 }});
 const pending=f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request);
 const reached=await Promise.race([ready.then(()=>true),pending.then(()=>false)]);assert.equal(reached,true,'handoff barrier must run');
 assert.equal(f.events.includes('select'),false);assert.equal(f.events.includes('published'),false);
 release();assert.equal((await pending).member.id,'child-1');await f.host.dispose();
});

test('a wrong handoff receipt cannot start or publish a member',async()=>{
 const f=fixture({handoffAdmission:async()=>({state:{revision:2,controller:'role',phase:'active'},binding:{revision:2,run_id:'foreign-run',session_ref:'foreign-session'}})});
 await assert.rejects(f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request),/native_handoff_admission_invalid/);
 assert.equal(f.events.includes('select'),false);assert.equal(f.events.includes('published'),false);await f.host.dispose();
});

test('handoff admission rejects stale controller, closed phase and mismatched revisions',async()=>{
 for(const mutate of [receipt=>({...receipt,state:{...receipt.state,controller:'other-role'}}),receipt=>({...receipt,state:{...receipt.state,phase:'returned'}}),receipt=>({...receipt,binding:{...receipt.binding,revision:3}})]){
  const f=fixture({handoffAdmission:async({binding,roleRef})=>mutate({state:{revision:2,controller:roleRef,phase:'active'},binding:{revision:2,run_id:binding.runId,session_ref:binding.sessionRef}})});
  await assert.rejects(f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request),/native_handoff_admission_invalid/);
  assert.equal(f.events.includes('select'),false);assert.equal(f.events.includes('published'),false);await f.host.dispose();
 }
});
test('backend identity mismatch cannot publish a child or invoke model selection',async()=>{const f=fixture();f.bridge.request=async()=>({reservation:{child_session_ref:'different',role_id:'role',reservation_id:'id'}});await assert.rejects(f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request),/native_role_reservation_invalid/);assert.equal(f.entries.size,1);assert.deepEqual(f.events,[]);await f.host.dispose();});
test('host disposal during pending backend work rejects creation and cannot reuse its scope',async()=>{const f=fixture();let resolve;const ready=new Promise(done=>resolve=done),original=f.bridge.request;f.bridge.request=async(...args)=>{await ready;return original(...args);};const pending=f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request);await new Promise(done=>setImmediate(done));f.host.dispose();resolve();await assert.rejects(pending,/native_role_host_disposed/);assert.equal(f.entries.size,1);await assert.rejects(f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'next'},f.request),/native_role_host_disposed/);});
test('disposal after preparation keeps the serial barrier installed until native creation observes cancellation',async()=>{const f=fixture();let prepared,release;const ready=new Promise(done=>prepared=done),pause=new Promise(done=>release=done);f.ctx.agentTeams.spawnTeammate=async(parent,request)=>{await f.host.provider.prepareContinuable({parent,sessionId:'child-pending',signal:request.signal});prepared();await pause;request.signal.throwIfAborted();throw Error('must not publish');};const pending=f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request);await ready;const stopping=f.host.dispose();assert.equal(f.hooks.has('agent/created'),true);release();await assert.rejects(pending,/native_role_host_disposed/);await stopping;assert.equal(f.hooks.size,0);assert.equal(f.entries.size,1);});
test('published children drain under their exact native parent before the admission hook is removed',async()=>{const f=fixture();const result=await f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request);let release;const drain=new Promise(done=>release=done);let called=false;f.ctx.subagents.drainContinuableChildren=async(parent,ids)=>{assert.equal(parent,f.root);assert.deepEqual(ids,[result.member.id]);called=true;await drain;};const stopping=f.host.dispose();await new Promise(done=>setImmediate(done));assert.equal(called,true);assert.equal(f.hooks.has('agent/created'),true);release();await stopping;assert.equal(f.hooks.size,0);});
test('native idle eviction before spawn returns retains completed admission without granting cold-resume authority',async()=>{const f=fixture(),spawn=f.ctx.agentTeams.spawnTeammate;f.ctx.agentTeams.spawnTeammate=async(...args)=>{const result=await spawn(...args);f.entries.delete(result.member.id);return result;};const result=await f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request);assert.equal(result.member.id,'child-1');assert.equal(f.entries.get(result.member.id),undefined);assert.equal(f.host.admission.accepted.get(result.member.id).parent,f.root);await f.host.dispose();});
test('automatic lifecycle closure requires official persistence and inbox services before installing hooks',async()=>{const f=fixture();assert.throws(()=>createNativeRoleHost({ctx:f.ctx,bridge:f.bridge,selectModel:async()=>{},automaticClosures:true}),/native_role_closure_host_incompatible/);await f.host.dispose();});

for(const sameParent of [false,true])test(sameParent?'another member pending spawn under the same parent does not hold closure':'another parent pending spawn does not hold a disposed member closure',async()=>{
 const f=fixture();await f.host.dispose();let child,writes=0,release,entered,recorded,deadline;
 const closureRecorded=new Promise(resolve=>recorded=resolve);
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),spawn=f.ctx.agentTeams.spawnTeammate,request=f.bridge.request;
 f.ctx.agentTeams.spawnTeammate=async(parent,args)=>{if(args.name==='Slow role'){if(sameParent)await host.provider.prepareContinuable({parent,sessionId:'slow-child',signal:args.signal});entered();await gate;throw Error('slow spawn stopped');}return spawn(parent,args);};
 f.bridge.request=async(path,b,args)=>{if(path==='native-child-close'){assert.equal(b.sessionRef,child.id);assert.equal(args.proof.parent_session_ref,f.root.id);writes++;recorded();return {closed:true,run_id:b.runId};}return request(path,b,args);};
 const events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'turn/end',data:{}}];
 const persistence={flush:async()=>{},open:async()=>({id:child.id,access:'read',header:child.session.header,read:async(offset,count)=>({events:events.slice(offset,offset+count)}),close:async()=>{}})};
 f.ctx.sessionProjections={stateOf:()=>({'next-turn':[],'next-step':[]})};
 const host=createNativeRoleHost({ctx:f.ctx,bridge:f.bridge,selectModel:async()=>{},persistence,automaticClosures:true});let slow;
 try{
  const created=await host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'finished'},f.request);child=f.entries.get(created.member.id);child.status='idle';child.whenIdle=async()=>{};Object.assign(child.session,{seq:2,eventAt:i=>events[i]});
  const parent=sameParent?f.root:f.make('other-root');if(!sameParent)f.bindings.set(parent,Object.freeze({runId:'other-root-run',sessionRef:parent.id}));
  slow=host.spawn(parent,{roleRef:'slow-role',policyVersion:1,requestId:'slow'}, {...f.request,name:'Slow role'});const stopped=assert.rejects(slow,/slow spawn stopped/);await ready;
  f.entries.delete(child.id);f.hooks.get('session/disposed')(child.session);
  await Promise.race([closureRecorded,new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('unrelated spawn blocked closure')),1000))]);clearTimeout(deadline);
  assert.equal(writes,1,'closure must wait only for its own member publication');
  release();await stopped;await host.flushClosures();assert.equal(writes,1);
 }finally{clearTimeout(deadline);release();await Promise.allSettled([slow]);await host.dispose();}
});

test('a disposed member waits for its own pending publication before closure',async()=>{
 const f=fixture();await f.host.dispose();let child,writes=0,release,entered;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),spawn=f.ctx.agentTeams.spawnTeammate,request=f.bridge.request;
 const events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'turn/end',data:{}}];
 f.ctx.sessionProjections={stateOf:()=>({'next-turn':[],'next-step':[]})};
 const persistence={flush:async()=>{},open:async()=>({id:child.id,access:'read',header:child.session.header,read:async(offset,count)=>({events:events.slice(offset,offset+count)}),close:async()=>{}})};
 f.bridge.request=async(path,b,args)=>{if(path==='native-child-close'){writes++;return {closed:true,run_id:b.runId};}return request(path,b,args);};
 const host=createNativeRoleHost({ctx:f.ctx,bridge:f.bridge,selectModel:async()=>{},persistence,automaticClosures:true});let publishing;
 f.ctx.agentTeams.spawnTeammate=async(...args)=>{const result=await spawn(...args);child=f.entries.get(result.member.id);child.status='idle';child.whenIdle=async()=>{};Object.assign(child.session,{seq:2,eventAt:i=>events[i]});f.entries.delete(child.id);f.hooks.get('session/disposed')(child.session);entered();await gate;return result;};
 try{publishing=host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'own-publication'},f.request);await ready;
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,0);
  release();await publishing;await host.flushClosures();assert.equal(writes,1);
 }finally{release();await Promise.allSettled([publishing]);await host.dispose();}
});

test('closure waits for recovery publication of the same durable reserved member',async()=>{
 const f=fixture();await f.host.dispose();let child,childId,attempts=0,writes=0,release,entered;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve),request=f.bridge.request,spawn=f.ctx.agentTeams.spawnTeammate;
 const member={id:'child-1',name:'Saved role',description:'Review',provider:'jot-native-role',context:'fresh',phase:'active'};
 const parentEvents=[{seq:0,type:'team/member',data:{version:2,teamId:'root',member}}],events=[{seq:0,type:'subagent/descriptor',data:{version:3,mode:'continuable',provider:member.provider,label:member.description}},{seq:1,type:'user/message',data:{id:'initial',source:{kind:'user'},content:f.request.prompt}},{seq:2,type:'turn/start',data:{}},{seq:3,type:'turn/end',data:{}}];
 const persistence={flush:async()=>{},open:async id=>({id,access:'read',header:id==='root'?f.root.session.header:child.session.header,read:async(offset,count)=>({events:(id==='root'?parentEvents:events).slice(offset,offset+count)}),close:async()=>{}})};
 f.ctx.sessionProjections={stateOf:()=>({'next-turn':[],'next-step':[]})};f.ctx.agentTeams.listMembers=()=>[{...member,role:'teammate',status:'inactive',diagnostics:[]}];
 f.ctx.agentTeams.spawnTeammate=async(...args)=>{const result=await spawn(...args);child=f.entries.get(result.member.id);child.status='idle';child.whenIdle=async()=>{};Object.assign(child.session,{seq:4,eventAt:i=>events[i]});Object.assign(f.root.session,{seq:1,eventAt:i=>parentEvents[i]});return result;};
 f.bridge.request=async(path,b,args)=>{
  if(path==='native-child-request')return {reservation:childId?{child_session_ref:childId}:null};
  if(path==='native-child-reservation')childId=args.child_session_ref;
  if(path==='native-child-published'){if(++attempts===1)throw Error('publication not committed');entered();await gate;return {publication:args.publication};}
  if(path==='native-child-close'){writes++;return {closed:true,run_id:b.runId};}return request(path,b,args);
 };
 const host=createNativeRoleHost({ctx:f.ctx,bridge:f.bridge,selectModel:async()=>{},persistence,automaticClosures:true,durableSpawns:true}),intent={roleRef:'role',policyVersion:1,requestId:'recovered-publication'};let recovering;
 try{await assert.rejects(host.spawn(f.root,intent,f.request),/publication not committed/);recovering=host.spawn(f.root,intent,f.request);await ready;
  f.entries.delete(child.id);f.hooks.get('session/disposed')(child.session);await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,0,'the exact recovered publication must settle first');
  release();assert.equal((await recovering).member.id,'child-1');await host.flushClosures();assert.equal(writes,1);assert.equal(f.events.filter(event=>event==='published').length,1);
 }finally{release();await Promise.allSettled([recovering]);await host.dispose();}
});

test('trusted close notification follows durable closure and can retry without closing or spawning again',async()=>{
 const f=fixture();await f.host.dispose();let child,writes=0,notified=0;const original=f.bridge.request;
 f.bridge.request=async(path,b,p)=>{if(path==='native-child-close'){writes++;return {closed:true,run_id:b.runId};}return original(path,b,p);};
 const events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'turn/end',data:{}}],persistence={flush:async()=>{},open:async()=>({id:child.id,access:'read',header:child.session.header,read:async(offset,count)=>({events:events.slice(offset,offset+count)}),close:async()=>{}})};f.ctx.sessionProjections={stateOf:()=>({'next-turn':[],'next-step':[]})};
 const host=createNativeRoleHost({ctx:f.ctx,bridge:f.bridge,selectModel:async()=>{},persistence,onMemberClosed:async scope=>{assert.equal(writes,1);assert.equal(scope.parent,f.root);assert.equal(scope.child,child);assert.equal(scope.receipt.closed,true);assert.equal(scope.roleRef,'role');assert.equal(scope.parentBinding,f.bridge.bindingFor(f.root));notified++;if(notified===1)throw Error('return pending');}});
 const created=await host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'notify'},f.request);child=f.entries.get(created.member.id);child.status='idle';child.whenIdle=async()=>{};Object.assign(child.session,{seq:2,eventAt:i=>events[i]});f.ctx.subagents.drainContinuableChildren=async()=>f.entries.delete(child.id);
 await assert.rejects(host.closeMember(f.root,child.id),/return pending/);assert.equal(writes,1);assert.equal((await host.closeMember(f.root,child.id)).closed,true);assert.equal(writes,1);await host.closeMember(f.root,child.id);assert.equal(notified,2);await host.dispose();
});
test('durable spawn shares concurrent requests and replays saved publication after a lost acknowledgement',async()=>{
 const f=fixture({durableSpawns:true}),original=f.bridge.request,intent={roleRef:'role',policyVersion:1,requestId:'request'};let saved,publication,loseAck=true;
 f.bridge.request=async(path,b,p)=>{
  if(path==='native-child-request'){if(saved&&saved.hash!==p.spawn_request_hash)throw Error('idempotency_conflict');return {reservation:saved?{child_session_ref:saved.id,...(publication?{publication}:{} )}:null};}
  if(path==='native-child-reservation')saved={id:p.child_session_ref,hash:p.spawn_request_hash};
  if(path==='native-child-published'){publication=p.publication;if(loseAck){loseAck=false;throw Error('lost acknowledgement');}return {publication};}
  return original(path,b,p);
 };
 const first=f.host.spawn(f.root,intent,f.request),second=f.host.spawn(f.root,intent,{...f.request,signal:new AbortController().signal});
 await assert.rejects(first,/lost acknowledgement/);await assert.rejects(second,/lost acknowledgement/);
 assert.equal(f.events.filter(value=>value==='published').length,1);
 assert.deepEqual(await f.host.spawn(f.root,intent,f.request),publication);
 await assert.rejects(f.host.spawn(f.root,intent,{...f.request,prompt:[{type:'text',text:'changed'}]}),/idempotency_conflict/);
 assert.equal(f.entries.size,2);await f.host.dispose();
});
test('an unresolved durable reservation never creates another native member',async()=>{
 const f=fixture({durableSpawns:true});f.bridge.request=async()=>({reservation:{child_session_ref:'already-reserved'}});
 await assert.rejects(f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request),/native_role_publication_pending/);
 assert.equal(f.entries.size,1);assert.equal(f.events.length,0);await f.host.dispose();
});

test('native admission installs the exact parent authority check on each child binding',async()=>{
 const f=fixture();let parentGuard;const original=f.bridge.attach;
 f.bridge.attach=async(a,b,options)=>{parentGuard=options.parentGuard;return original(a,b,options);};
 await f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'guarded-member'},f.request);
 assert.equal(typeof parentGuard,'function');
 f.bridge.guardBudget=async parent=>{assert.equal(parent,f.root);throw Error('parent_stopped');};
 await assert.rejects(parentGuard(new AbortController().signal),/parent_stopped/);await f.host.dispose();
});

test('host reads original batch through the real loopback bridge and guards the detached member before closure',async()=>{
 const {createServer}=await import('node:http');const f=fixture();await f.host.dispose();let reads=0,guards=0,closed=0;
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);assert.equal(req.url,'/v2/native/tool');assert.equal(data.tool,'universe_get_state');assert.equal(data.arguments.request_id,'batch-call');assert.equal(data.execution.session_ref,'child-1');reads++;res.setHeader('content-type','application/json');res.end(JSON.stringify({kind:'read_page',operation_id:'web-'+ 'b'.repeat(32),revision:1,status:'succeeded',accepted_count:1,items:[{item_id:'one',position:0,status:'succeeded'}]}));});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const prior=f.bridge.request;f.bridge.guard=async agent=>{assert.equal(agent.id,'child-1');guards++;};f.bridge.request=async(path,b,p)=>{if(path==='native-child-close'){assert.equal(reads,1);assert.equal(guards,2);closed++;return {closed:true,run_id:b.runId};}return prior(path,b,p);};
 const events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'tool/call',data:{callId:'batch-call',name:'universe_read_page',arguments:{urls:['https://example.com']}}},{seq:2,type:'tool/result',data:{message:{source:{callId:'batch-call'}}}},{seq:3,type:'turn/end',data:{}}];let child;
 const persistence={flush:async()=>{},open:async()=>({id:child.id,access:'read',header:child.session.header,read:async(offset,count)=>({events:events.slice(offset,offset+count)}),close:async()=>{}})};
 f.ctx.sessionProjections={stateOf:()=>({'next-turn':[],'next-step':[]})};
 const host=createNativeRoleHost({ctx:f.ctx,bridge:f.bridge,selectModel:async()=>{},persistence,nativeOperationOrigin:'http://127.0.0.1:'+server.address().port});
 try{const result=await host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request);child=f.entries.get(result.member.id);child.status='idle';child.whenIdle=async()=>{};Object.assign(child.session,{seq:4,eventAt:i=>events[i]});f.ctx.subagents.drainContinuableChildren=async()=>{f.entries.delete(child.id);};assert.equal((await host.closeMember(f.root,child.id)).closed,true);assert.equal(closed,1);}
 finally{await host.dispose();server.closeAllConnections();await new Promise(done=>server.close(done));}
});

test('native member roster and interrupt resolve only the originally admitted child by its exact Team name',async()=>{
 const f=fixture(),rows=[],interrupts=[];
 f.ctx.agentTeams.listMembers=parent=>{assert.equal(parent,f.root);return rows;};
 f.ctx.agentTeams.interrupt=(parent,targetName)=>{assert.equal(parent,f.root);interrupts.push(targetName);};
 const created=await f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'member-control'},f.request),child=f.entries.get(created.member.id);
 child.name='Saved role';rows.push({id:child.id,name:'Saved role',role:'teammate',status:'running'},{id:'unrelated',name:'Other member',role:'teammate',status:'running'});
 assert.deepEqual(await f.host.listMembers(f.root),[{id:child.id,name:'Saved role',role:'teammate',status:'running'}]);
 const receipt=await f.host.interruptMember(f.root,child.id,{requestId:'stop-1',signal:new AbortController().signal});
 assert.deepEqual(receipt,{request_id:'stop-1',status:'accepted',quiescent:false,execution_authorized:false});assert.deepEqual(interrupts,['Saved role']);
 await assert.rejects(f.host.interruptMember(f.root,'unrelated',{requestId:'stop-2'}),/native_role_interrupt_member_invalid/);
 assert.deepEqual(interrupts,['Saved role']);await f.host.dispose();
});

test('native member wake requires the exact bound parent and preserves an unknown receipt',async()=>{
 const parent={id:'parent'},calls=[],body={request_id:'wake-1',text:'Continue the assigned task.'};
 const handler=createAdapterHandler({token,agents:{get:id=>id==='parent'?parent:null},workbenchBridge:{bindingFor:agent=>agent===parent?{sessionRef:'parent',runId:'parent-run'}:undefined},
  nativeRoleHost:{wakeMember:async(agent,child,request)=>{assert.equal(agent,parent);assert.equal(child,'child');assert.deepEqual(request,{requestId:'wake-1',text:body.text,signal:request.signal});calls.push(child);return {request_id:'wake-1',status:'unknown',execution_authorized:false};}}});
 assert.equal((await invoke(handler,'/v1/sessions/parent/native-members/child/messages',body,false)).status,401);
 assert.equal((await invoke(handler,'/v1/sessions/foreign/native-members/child/messages',body)).status,409);
 assert.equal((await invoke(handler,'/v1/sessions/parent/native-members/child/messages',{...body,run_id:'forged'})).status,422);
 const reply=await invoke(handler,'/v1/sessions/parent/native-members/child/messages',body);
 assert.equal(reply.status,200);assert.deepEqual(reply.value,{request_id:'wake-1',status:'unknown',execution_authorized:false});assert.deepEqual(calls,['child']);
});
test('native member roster and interrupt require the authenticated bound parent and exact child identity',async()=>{
 const parent={id:'parent'},calls=[],members=[{id:'child',name:'Reviewer',role:'teammate',status:'running'}];
 const handler=createAdapterHandler({token,agents:{get:id=>id==='parent'?parent:null},workbenchBridge:{bindingFor:agent=>agent===parent?{sessionRef:'parent',runId:'parent-run'}:undefined},
  nativeRoleHost:{listMembers:async agent=>{assert.equal(agent,parent);calls.push('list');return members;},
   interruptMember:async(agent,child,request)=>{assert.equal(agent,parent);assert.equal(child,'child');assert.deepEqual(request,{requestId:'stop-1',signal:request.signal});calls.push(child);return {request_id:'stop-1',status:'accepted',quiescent:false,execution_authorized:false};}}});
 assert.equal((await invoke(handler,'/v1/sessions/parent/native-members/list',{},false)).status,401);
 assert.equal((await invoke(handler,'/v1/sessions/foreign/native-members/list')).status,409);
 assert.equal((await invoke(handler,'/v1/sessions/parent/native-members/list',{extra:true})).status,422);
 assert.deepEqual(calls,[]);
 const roster=await invoke(handler,'/v1/sessions/parent/native-members/list');
 assert.equal(roster.status,200);assert.deepEqual(roster.value,{members,execution_authorized:false});
 assert.equal((await invoke(handler,'/v1/sessions/parent/native-members/foreign/interrupt',{request_id:'stop-1'})).status,409);
 assert.equal((await invoke(handler,'/v1/sessions/parent/native-members/child/interrupt',{request_id:'stop-1',child_session_ref:'forged'})).status,422);
 const stopped=await invoke(handler,'/v1/sessions/parent/native-members/child/interrupt',{request_id:'stop-1'});
 assert.equal(stopped.status,200);assert.deepEqual(stopped.value,{request_id:'stop-1',status:'accepted',quiescent:false,execution_authorized:false});
 assert.deepEqual(calls,['list','child']);
});
test('authenticated adapter controls the exact bound native child and leaves parent state intact',async()=>{
 const parent={id:'parent',session:{id:'parent',header:{}}},parentBinding={sessionRef:'parent',runId:'parent-run'},agents=new Map([['parent',parent]]),providers=new Map(),roster=[],interrupts=[];
 let onCreated,child,childBinding;
 const ctx={agents:{get:id=>agents.get(id),list:()=>[...agents.values()],isOwnedBy:(id,owner)=>agents.get(id)?.session?.header?.parentSession===owner.id},
  subagents:{registerProvider:provider=>(providers.set(provider.name,provider),()=>providers.delete(provider.name)),drainChildren:async()=>{}},
  agentTeams:{spawnTeammate:async(owner,options)=>{const provider=providers.get(options.provider);await provider.prepareContinuable({parent:owner,sessionId:'child',signal:options.signal});
   child={id:'child',name:'Reviewer',session:{id:'child',header:{parentSession:'parent'}},ctx:{tools:{guard:()=>()=>{}},on:()=>()=>{}}};agents.set('child',child);await onCreated({agent:child,signal:options.signal});
   roster.push({id:'child',name:'Reviewer',role:'teammate',status:'running'});return {member:{id:'child'}};},
   listMembers:owner=>{assert.equal(owner,parent);return roster;},interrupt:async(owner,targetName)=>{assert.equal(owner,parent);interrupts.push(targetName);}},
  on:(name,listener)=>{if(name==='agent/created')onCreated=listener;return()=>{};}};
 const bridge={bindingFor:agent=>agent===parent?parentBinding:agent===child?childBinding:undefined,guardBudget:async()=>{},attach:async(_child,binding)=>{childBinding=binding;},
  request:async(path,_binding,payload)=>{
   if(path==='native-child-reservation')return {reservation:{child_session_ref:'child',role_id:payload.role_ref,reservation_id:'reserve-1'}};
   if(path==='native-child-bind')return {binding:{sessionRef:'child',runId:'child-run'}};
   if(path==='native-child-abort')return {aborted:true,child_session_ref:'child'};
   return {};
  }};
 const host=createNativeRoleHost({ctx,bridge,selectModel:async()=>{}}),handler=createAdapterHandler({token,agents,workbenchBridge:{bindingFor:agent=>bridge.bindingFor(agent)},nativeRoleHost:host});
 const before=structuredClone({goal:{id:'goal',revision:7},budget:{remaining:41},parentId:parent.id});
 await host.spawn(parent,{roleRef:'saved-role',policyVersion:1,requestId:'spawn-1'},{name:'Reviewer',description:'Review',context:'fresh',prompt:[{type:'text',text:'Start'}],signal:new AbortController().signal});
 const listed=await invoke(handler,'/v1/sessions/parent/native-members/list');assert.equal(listed.status,200);assert.deepEqual(listed.value,{members:[{id:'child',name:'Reviewer',role:'teammate',status:'running'}],execution_authorized:false});
 const denied=await invoke(handler,'/v1/sessions/parent/native-members/child/interrupt',{request_id:'stop-1'},false);assert.equal(denied.status,401);
 const interrupted=await invoke(handler,'/v1/sessions/parent/native-members/child/interrupt',{request_id:'stop-1'});assert.equal(interrupted.status,200);
 assert.deepEqual(interrupted.value,{request_id:'stop-1',status:'accepted',quiescent:false,execution_authorized:false});assert.deepEqual(interrupts,['Reviewer']);
 assert.deepEqual({goal:{id:'goal',revision:7},budget:{remaining:41},parentId:parent.id},before);
 await host.dispose();
});
test('native role host does not resend a wake after an uncertain Team message',async()=>{
 const parent={id:'parent',session:{id:'parent',header:{}}},parentBinding={sessionRef:'parent',runId:'parent-run'},agents=new Map([['parent',parent]]),providers=new Map(),roster=[],sends=[],receipts=[];
 let onCreated,childBinding,receiptState='none';
 const ctx={agents:{get:id=>agents.get(id),list:()=>[...agents.values()],isOwnedBy:(id,owner)=>agents.get(id)?.session?.header?.parentSession===owner.id},
  subagents:{registerProvider:provider=>(providers.set(provider.name,provider),()=>providers.delete(provider.name)),drainContinuableChildren:async()=>{}},
  agentTeams:{listMembers:()=>roster,spawnTeammate:async(owner,options)=>{
   const provider=providers.get(options.provider);await provider.prepareContinuable({parent:owner,sessionId:'child',signal:options.signal});
   const child={id:'child',name:'Reviewer',session:{id:'child',header:{parentSession:'parent'}},ctx:{tools:{guard:()=>()=>{}},on:()=>()=>{}}};agents.set('child',child);
   await onCreated({agent:child,signal:options.signal});roster.push({id:'child',name:'Reviewer',role:'teammate',status:'inactive'});
   return {member:{id:'child',name:'Reviewer',role:'teammate',status:'inactive',diagnostics:[]}};
  },sendMessage:async(owner,message)=>{sends.push(message);throw Error('lost acknowledgement');}},
  on:(name,listener)=>{if(name==='agent/created')onCreated=listener;return ()=>{};}};
 const bridge={bindingFor:agent=>agent===parent?parentBinding:agent?.id==='child'?childBinding:undefined,guardBudget:async()=>{},
  attach:async(child,binding)=>{childBinding=binding;},request:async(path,binding,payload)=>{
   if(path==='native-child-reservation')return {reservation:{child_session_ref:'child',role_id:'role',reservation_id:'reserve-1'}};
   if(path==='native-child-bind')return {binding:{sessionRef:'child',runId:'child-run'}};
   if(path==='native-child-source'&&payload.action==='member-message'){
    receipts.push(payload.receipt_action);
    if(payload.receipt_action==='complete'){receiptState=payload.result;return {state:receiptState};}
    if(receiptState==='unknown')return {decision:'unknown'};
    if(receiptState==='accepted')return {decision:'accepted'};
    receiptState='dispatching';return {decision:'dispatch'};
   }
   throw Error('unexpected native host request');
  }};
 const host=createNativeRoleHost({ctx,bridge,selectModel:async()=>{}});
 await host.spawn(parent,{roleRef:'role',policyVersion:1,requestId:'spawn-1'},{name:'Reviewer',description:'Review',context:'fresh',prompt:[{type:'text',text:'Start'}],signal:new AbortController().signal});
 const request={requestId:'wake-1',text:'Continue the assigned task.',signal:new AbortController().signal};
 assert.deepEqual(await host.wakeMember(parent,'child',request),{request_id:'wake-1',status:'unknown',execution_authorized:false});
 assert.deepEqual(await host.wakeMember(parent,'child',request),{request_id:'wake-1',status:'unknown',execution_authorized:false});
 assert.equal(sends.length,1);assert.deepEqual(receipts,['begin','complete','begin']);assert.equal(sends[0].target,'Reviewer');
 assert.deepEqual(sends[0].content,[{type:'text',text:request.text}]);assert.equal(sends[0].signal.aborted,false);
 roster.push({id:'other',name:'Reviewer',role:'teammate',status:'inactive'});
 await assert.rejects(host.wakeMember(parent,'child',{...request,requestId:'wake-2'}),/native_role_wake_member_invalid/);
 assert.equal(sends.length,1);assert.deepEqual(receipts,['begin','complete','begin']);
 await host.dispose();
});
test('explicit owner wake cold-recovers the same native child Session through its closed prefix',async()=>{
 const f=fixture(),parent=f.root,parentBinding=f.bridge.bindingFor(parent),events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'turn/end',data:{}}],header={parentSession:parent.id};
 const digest=createHash('sha256').update(canonical({...header,delegationDepth:0})+'\n'+events.map(event=>canonical(event)+'\n').join('')).digest('hex');
 const proof={protocol:1,session_ref:'child',parent_session_ref:parent.id,seq_exclusive:events.length,turn_end_seq:1,log_sha256:digest,driver_nonresident:true,inbox_pending:0};
 const persistence={flush:async()=>{},open:async id=>({id,access:'read',header,read:async(offset,count)=>({events:events.slice(offset,offset+count)}),close:async()=>{}})};
 f.ctx.sessionProjections={stateOf:()=>({'next-turn':[],'next-step':[]})};
 let onCreated,receiptState='none',newChildBinding,sends=0;const calls=[];
 f.ctx.agentTeams.listMembers=()=>[{id:'child',name:'Reviewer',role:'teammate',status:'inactive'}];
 f.ctx.agentTeams.sendMessage=async(owner,message)=>{
  assert.equal(owner,parent);assert.deepEqual(message.content,[{type:'text',text:'Continue the same assigned task.'}]);sends++;
  const child=f.make('child',parent);child.name='Reviewer';child.status='idle';child.whenIdle=async()=>{};Object.assign(child.session,{seq:events.length,eventAt:index=>events[index]});
  await onCreated({agent:child,signal:message.signal});return {status:'accepted'};
 };
 f.ctx.subagents.drainContinuableChildren=async(_owner,ids)=>{for(const id of ids)f.entries.delete(id);};
 f.ctx.on=(name,listener)=>{if(name==='agent/created')onCreated=listener;return()=>{};};
 f.bridge.attach=async(child,binding)=>{assert.equal(child.id,'child');newChildBinding=binding;f.bindings.set(child,Object.freeze({...binding}));};
 f.bridge.request=async(path,binding,payload)=>{
  if(path==='native-child-close')assert.equal(binding.runId,'child-run-new');else assert.equal(binding,parentBinding);calls.push([path,payload]);
  if(path==='native-child-source'&&payload.action==='member-message'){
   if(payload.receipt_action==='complete'){receiptState=payload.result;return {state:receiptState};}
   if(receiptState==='accepted')return {decision:'accepted'};
   if(receiptState==='unknown')return {decision:'unknown'};
   receiptState='dispatching';return {decision:'dispatch'};
  }
  if(path==='native-child-source')return {source:{previous_run_id:'child-run-old',role_ref:'saved-role',proof}};
  if(path==='native-child-activate')return {binding:{runId:'child-run-new',sessionRef:'child',executionLease:{owner:'worker',generation:2}}};
  if(path==='native-child-close')return {closed:true,run_id:binding.runId};
  throw Error('unexpected native host request');
 };
 const host=createNativeRoleHost({ctx:f.ctx,bridge:f.bridge,selectModel:async(child,guard)=>{assert.equal(child.id,'child');await guard();},persistence,automaticClosures:true,nativeRecovery:true});
 const input={requestId:'cold-wake-1',text:'Continue the same assigned task.',signal:new AbortController().signal};
 assert.deepEqual(await host.listMembers(parent),[{id:'child',name:'Reviewer',role:'teammate',status:'inactive'}]);
 assert.deepEqual(await host.wakeMember(parent,'child',input),{request_id:input.requestId,status:'accepted',execution_authorized:false});
 assert.equal(sends,1);assert.equal(parent.id,'root');assert.equal(f.bridge.bindingFor(parent),parentBinding);
 assert.equal(newChildBinding.sessionRef,'child');assert.equal(newChildBinding.runId,'child-run-new');assert.notEqual(newChildBinding.runId,'child-run-old');
 assert.deepEqual(calls.filter(([path])=>path==='native-child-activate').map(([,payload])=>payload),[{child_session_ref:'child',previous_run_id:'child-run-old',previous_log_sha256:digest,previous_seq_exclusive:2}]);
 assert.deepEqual(calls.filter(([path,payload])=>path==='native-child-source'&&payload.action==='member-message').map(([,payload])=>payload.receipt_action),['begin','complete']);
 assert.deepEqual(await host.wakeMember(parent,'child',input),{request_id:input.requestId,status:'accepted',execution_authorized:false});assert.equal(sends,1);
 await host.dispose();
});
test('native role host keeps spawn-only Team services compatible and refuses unsupported wake before dispatch',async()=>{
 const parent={id:'parent',session:{id:'parent',header:{}}},parentBinding={sessionRef:'parent',runId:'parent-run'},agents=new Map([['parent',parent]]),providers=new Map();
 let onCreated,childBinding,sourceCalls=0;
 const ctx={agents:{get:id=>agents.get(id),list:()=>[...agents.values()],isOwnedBy:(id,owner)=>agents.get(id)?.session?.header?.parentSession===owner.id},
  subagents:{registerProvider:provider=>(providers.set(provider.name,provider),()=>providers.delete(provider.name)),drainContinuableChildren:async()=>{}},
  agentTeams:{spawnTeammate:async(owner,options)=>{
   const provider=providers.get(options.provider);await provider.prepareContinuable({parent:owner,sessionId:'child',signal:options.signal});
   const child={id:'child',name:'Reviewer',session:{id:'child',header:{parentSession:'parent'}},ctx:{tools:{guard:()=>()=>{}},on:()=>()=>{}}};agents.set('child',child);
   await onCreated({agent:child,signal:options.signal});return {member:{id:'child'}};
  }},on:(name,listener)=>{if(name==='agent/created')onCreated=listener;return()=>{};}};
 const bridge={bindingFor:agent=>agent===parent?parentBinding:agent?.id==='child'?childBinding:undefined,guardBudget:async()=>{},
  attach:async(_child,binding)=>{childBinding=binding;},request:async(path,_binding,payload)=>{
   if(path==='native-child-reservation')return {reservation:{child_session_ref:'child',role_id:'role',reservation_id:'reserve-1'}};
   if(path==='native-child-bind')return {binding:{sessionRef:'child',runId:'child-run'}};
   if(path==='native-child-source'){sourceCalls++;return {decision:'dispatch'};}
   throw Error('unexpected native host request');
  }};
 const host=createNativeRoleHost({ctx,bridge,selectModel:async()=>{}});
 const spawned=await host.spawn(parent,{roleRef:'role',policyVersion:1,requestId:'spawn-only'},
  {name:'Reviewer',description:'Review',context:'fresh',prompt:[{type:'text',text:'Start'}],signal:new AbortController().signal});
 assert.equal(spawned.member.id,'child');
 await assert.rejects(host.wakeMember(parent,'child',{requestId:'wake-1',text:'Continue'}),/native_role_wake_unavailable/);
 assert.equal(sourceCalls,0);
 await host.dispose();
});
