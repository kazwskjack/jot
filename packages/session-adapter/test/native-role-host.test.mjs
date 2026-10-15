import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeRoleHost} from '../native-role-host.js';
function fixture(options={}){const entries=new Map(),owners=new Map(),bindings=new WeakMap(),events=[],hooks=new Map();let provider,counter=0;
 const make=(id,parent)=>{const barriers=new Map(),agent={id,session:{id,header:parent?{parentSession:parent.id}:{}},ctx:{tools:{guard:fn=>{barriers.set('tool',fn);return()=>barriers.delete('tool');}},on:(name,fn)=>{barriers.set(name,fn);return()=>barriers.delete(name);}},barriers};entries.set(id,agent);if(parent)owners.set(id,parent);return agent;};
 const root=make('root');bindings.set(root,Object.freeze({runId:'root-run',sessionRef:'root',executionLease:{owner:'worker',generation:1}}));
 const bridge={bindingFor:a=>bindings.get(a),guardBudget:async a=>{assert.ok(bindings.get(a));},attach:async(a,b)=>{events.push('attach');bindings.set(a,Object.freeze({...b}));},request:async(path,b,p)=>{assert.equal(b.sessionRef,'root');events.push(path);if(path==='native-child-reservation')return {reservation:{reservation_id:'reservation-'+p.child_session_ref,child_session_ref:p.child_session_ref,role_id:p.role_ref}};return {binding:{runId:'run-'+p.reservation_id,sessionRef:p.reservation_id.replace('reservation-',''),executionLease:{owner:'worker',generation:1}}};}};
 const ctx={agents:{get:id=>entries.get(id),list:()=>[...entries.values()],isOwnedBy:(id,p)=>owners.get(id)===p},on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name);},subagents:{drainContinuableChildren:async()=>{},registerProvider:p=>{provider=p;return()=>{provider=undefined;};}},agentTeams:{spawnTeammate:async(parent,request)=>{assert.equal(request.provider,'jot-native-role');const id='child-'+(++counter);await provider.prepareContinuable({parent,sessionId:id,signal:request.signal});const child=make(id,parent);await hooks.get('agent/created')({agent:child,signal:request.signal});events.push('published');return {member:{id}};}}};
 const selectModel=async(child,check)=>{assert.equal(child.barriers.get('tool')(),'NATIVE_CHILD_NOT_ADMITTED');await check();events.push('select');};
 const host=createNativeRoleHost({ctx,bridge,selectModel,...options});const request={name:'Saved role',description:'Review',prompt:[{type:'text',text:'Review evidence'}],context:'fresh',signal:new AbortController().signal};
 return {host,ctx,root,bridge,events,bindings,entries,request,hooks,make};}
test('named provider prepares backend identity, attaches a cloned binding and selects model before native publication',async()=>{const f=fixture();const result=await f.host.spawn(f.root,{roleRef:'role',policyVersion:1,requestId:'request'},f.request);assert.equal(result.member.id,'child-1');assert.deepEqual(f.events,['native-child-reservation','native-child-bind','attach','select','published']);assert.equal(f.entries.get('child-1').barriers.size,0);await f.host.dispose();});

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
