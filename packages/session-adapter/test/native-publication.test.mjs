import test from 'node:test';import assert from 'node:assert/strict';
import {recoverNativePublication} from '../native-child-closure.js';
function fixture(){
 const member={id:'child',name:'reviewer',description:'Review notes',provider:'jot-native-role',context:'fresh',phase:'active'},prompt=[{type:'text',text:'Review evidence'}];
 const events={parent:[{seq:0,type:'team/member',data:{version:2,teamId:'parent',member}}],child:[{seq:0,type:'subagent/descriptor',data:{version:3,mode:'continuable',provider:member.provider,label:member.description}},{seq:1,type:'user/message',data:{id:'initial',source:{kind:'user'},content:[...prompt,{type:'text',text:'Native return guidance'}]}}]};let closed=0;
 const parent={id:'parent',session:{id:'parent',header:{},seq:1,eventAt:i=>events.parent[i]}};
 const persistence={flush:async()=>{},open:async id=>({id,access:'read',header:id==='child'?{parentSession:'parent'}:{},read:async(offset,count)=>({events:events[id].slice(offset,offset+count)}),close:async()=>closed++})};
 const input={parent,childId:'child',request:{name:'reviewer',description:'Review notes',context:'fresh',prompt},providerName:'jot-native-role',persistence,teams:{listMembers:()=>[{...member,role:'teammate',status:'inactive',diagnostics:[]}]} };
 return {input,events,closed:()=>closed};
}
test('publication recovery requires persisted active Team edge and accepted exact initial task',async()=>{
 const f=fixture(),result=await recoverNativePublication(f.input);assert.equal(result.member.id,'child');assert.equal(result.member.status,'inactive');assert.equal(f.closed(),2);
});
test('provisioning, changed prompt, wrong parent and unflushed Team edge cannot recover a publication',async()=>{
 for(const alter of [f=>f.events.parent[0].data.member.phase='provisioning',f=>f.events.child[1].data.content[0]={type:'text',text:'different'},f=>{const open=f.input.persistence.open;f.input.persistence.open=async id=>({...await open(id),header:id==='child'?{parentSession:'other'}:{}});},f=>{const open=f.input.persistence.open;f.input.persistence.open=async id=>{const h=await open(id);if(id==='parent')h.read=async()=>({events:[]});return h;};}]){
  const f=fixture();alter(f);await assert.rejects(recoverNativePublication(f.input),/native_role_publication_pending/);assert.ok(f.closed()>=1);
 }
});
test('a later matching message cannot substitute for a different initial task',async()=>{
 const f=fixture(),initial=f.events.child[1];f.events.child.push({...initial,seq:2});f.events.child[1]={...initial,data:{...initial.data,content:[{type:'text',text:'Different initial task'}]}};
 await assert.rejects(recoverNativePublication(f.input),/native_role_publication_pending/);
});
test('an active edge may refer to an initial task still durably pending in the native inbox',async()=>{
 const f=fixture(),message=f.events.child[1].data;f.events.child[1]={seq:1,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[message]}};
 assert.equal((await recoverNativePublication(f.input)).member.id,'child');
 f.events.child.push({seq:2,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}});
 await assert.rejects(recoverNativePublication(f.input),/native_role_publication_pending/);
});
