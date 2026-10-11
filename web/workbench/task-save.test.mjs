import test from 'node:test';
import assert from 'node:assert/strict';
import * as save from './task-save.mjs';
import {blankTaskForm} from './form-state.mjs';
test('an in-progress receipt keeps the frozen command; a real version conflict permits rebasing',async()=>{
 const receipt=new save.TaskSaveReceipt(()=> 'fixed-key');
 await assert.rejects(()=>receipt.submit(async()=>{throw Object.assign(new Error('IDEMPOTENCY_IN_PROGRESS'),{status:409});},'/teams','POST',{name:'original'}));assert.equal(receipt.pending,true);
 await assert.rejects(()=>receipt.submit(async()=>{throw Object.assign(new Error('VERSION_CONFLICT'),{status:409});},'/teams','POST',{name:'edited'}));assert.equal(receipt.pending,false);
});
test('unknown create receipt freezes original body and key through edits and retries',async()=>{
 assert.equal(typeof save.TaskSaveReceipt,'function');
 const receipt=new save.TaskSaveReceipt(()=> 'fixed-key'),calls=[];
 const request=async(path,method,body,key)=>{calls.push({path,method,body,key});if(calls.length===1)throw new Error('connection lost');return {task_id:'t'};};
 const input={title:'original',source:{conversation_id:'c',message_id:'m'}};
 await assert.rejects(receipt.submit(request,'/persistent-tasks','POST',input));
 input.title='edited';input.source.message_id='changed';
 assert.equal(receipt.pending,true);
 await receipt.submit(request,'/different','PATCH',{title:'replacement'});
 assert.deepEqual(calls[1],calls[0]);assert.equal(calls[1].body.source.message_id,'m');assert.equal(receipt.pending,false);
});
test('known validation failures allow correction with a new request key; timeout stays pending',async()=>{
 const receipt=new save.TaskSaveReceipt(()=>`key-${++counter}`);let counter=0;
 await assert.rejects(receipt.submit(async()=>{throw Object.assign(new Error('invalid'),{status:422});},'/tasks','POST',{}));
 assert.equal(receipt.pending,false);
 await assert.rejects(receipt.submit(async()=>{throw Object.assign(new Error('timeout'),{status:408});},'/tasks','POST',{}));
 assert.equal(receipt.pending,true);assert.equal(counter,2);
});
const memory=()=>{const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};};
test('task draft and unknown command survive remount without resending and remain owner scoped',async()=>{
 assert.equal(typeof save.TaskDraftStore,'function');
 const storage=memory(),store=new save.TaskDraftStore(storage,'a'.repeat(64));
 store.saveDraft({...blankTaskForm('a'),title:'Follow up',objective:'Watch updates'},null,2);
 const first=new save.TaskSaveReceipt(()=> 'request-1',store);let calls=0;
 await assert.rejects(first.submit(async()=>{calls++;throw new Error('lost receipt');},'/persistent-tasks','POST',{title:'Follow up'}));
 const restored=new save.TaskDraftStore(storage,'a'.repeat(64)),second=new save.TaskSaveReceipt(()=> 'wrong-key',restored);
 assert.equal(calls,1);assert.equal(second.pending,true);assert.equal(restored.read().form.title,'Follow up');
 assert.equal(new save.TaskDraftStore(storage,'b'.repeat(64)).read(),null);
 await second.submit(async(path,method,body,key)=>{assert.equal(path,'/persistent-tasks');assert.equal(key,'request-1');assert.equal(body.title,'Follow up');},'/unrelated','DELETE',{});
 assert.equal(restored.read().command,null);assert.equal(restored.read().form,null);
 restored.clear();assert.equal(restored.read(),null);
});
test('a draft persistence failure prevents a network command and clear cannot discard an unknown receipt',async()=>{
 const bad={...memory(),setItem(){throw new Error('quota exceeded');}},store=new save.TaskDraftStore(bad,'c'.repeat(64));let calls=0;
 await assert.rejects(new save.TaskSaveReceipt(()=> 'fixed',store).submit(async()=>{calls++;},'/persistent-tasks','POST',{title:'x'}));assert.equal(calls,0);
 const good=new save.TaskDraftStore(memory(),'d'.repeat(64));good.saveCommand({path:'/persistent-tasks',method:'POST',body:{title:'x'},key:'fixed'});assert.throws(()=>good.clear(),/回执/);
 assert.throws(()=>good.saveCommand({path:'/conversations/c/messages',method:'POST',body:{},key:'fixed'}));
 assert.throws(()=>good.saveDraft({session_id:'private'},null,0));
});
test('damaged draft values cannot crash the review UI or inject hidden authority',()=>{
 const storage=memory(),store=new save.TaskDraftStore(storage,'e'.repeat(64));
 storage.setItem(store.key,JSON.stringify({version:1,form:{title:{text:'wrong type'}},editing:null,step:0,command:null}));assert.throws(()=>store.read());
 assert.throws(()=>new save.TaskDraftStore(memory(),'not-a-server-namespace'));
 assert.throws(()=>store.saveDraft({title:'missing rest of form'},null,0));
});
test('edit draft persists only the supported task fields while retaining its CAS version',()=>{
 const store=new save.TaskDraftStore(memory(),'f'.repeat(64));
 store.saveDraft(blankTaskForm('a'),{task_id:'task-1',version:7,title:'Task',generation:3,projection_pending:true,owner_id:'must-not-copy'},0);
 assert.deepEqual(store.read().editing,{task_id:'task-1',version:7,title:'Task'});
});
