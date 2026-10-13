import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdapterHandler} from '../index.js';
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
test('ordinary native goal controls authenticate and preserve revision conflicts',async()=>{
 const goal={id:'goal',revision:2,phase:'active'};
 const handler=createAdapterHandler({token,agents:{get:()=>({ctx:{get:()=>({get:()=>goal,pause:()=>({...goal,revision:3,phase:'paused'})})}})}});
 assert.equal((await invoke(handler,'/v1/sessions/chat/conversation-goal',{},false)).status,401);
 assert.equal((await invoke(handler,'/v1/sessions/chat/conversation-goal',{action:'pause',id:'goal',revision:1})).status,409);
 assert.equal((await invoke(handler,'/v1/sessions/chat/conversation-goal',{action:'pause',id:'goal',revision:2})).status,200);
});
