import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdapterHandler} from '../index.js';
import {createNativeRoleHost} from '../native-role-host.js';
const token='t'.repeat(32);
const invoke=(handler,path,body={},authorized=true)=>handler({method:'POST',url:new URL('http://127.0.0.1'+path),headers:authorized?{authorization:`Bearer ${token}`}:{},body,signal:new AbortController().signal});
test('native member endpoint preserves trusted parent binding and cannot accept caller identity',async()=>{
 const parent={id:'parent'},calls=[];
 const handler=createAdapterHandler({token,agents:{get:id=>id==='parent'?parent:null},workbenchBridge:{bindingFor:()=>({sessionRef:'parent'}),guardBudget:async()=>calls.push('guard')},nativeRoleHost:{spawn:async(agent,intent,request)=>{assert.equal(agent,parent);assert.equal(request.context,'fresh');assert.equal(intent.roleRef,'saved-role');calls.push('spawn');return {member:{id:'child'}};}}});
 const body={role_ref:'saved-role',expected_policy_version:1,request_id:'request',name:'Reviewer',description:'Review evidence',text:'Check the sources'};
 assert.equal((await invoke(handler,'/v1/sessions/parent/native-members',body,false)).status,401);
 assert.equal((await invoke(handler,'/v1/sessions/parent/native-members',{...body,run_id:'forged'})).status,422);
 assert.equal((await invoke(handler,'/v1/sessions/foreign/native-members',body)).status,409);
 assert.deepEqual(calls,[]);
 assert.equal((await invoke(handler,'/v1/sessions/parent/native-members',body)).status,201);
 assert.deepEqual(calls,['guard','spawn']);
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
test('ordinary native goal controls authenticate and preserve revision conflicts',async()=>{
 const goal={id:'goal',revision:2,phase:'active'};
 const handler=createAdapterHandler({token,agents:{get:()=>({ctx:{get:()=>({get:()=>goal,pause:()=>({...goal,revision:3,phase:'paused'})})}})}});
 assert.equal((await invoke(handler,'/v1/sessions/chat/conversation-goal',{},false)).status,401);
 assert.equal((await invoke(handler,'/v1/sessions/chat/conversation-goal',{action:'pause',id:'goal',revision:1})).status,409);
 assert.equal((await invoke(handler,'/v1/sessions/chat/conversation-goal',{action:'pause',id:'goal',revision:2})).status,200);
});
