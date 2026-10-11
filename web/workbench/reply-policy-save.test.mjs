import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplyPolicyReceiptStore,replyFormFromPolicy} from './reply-policy-save.mjs';
import {TaskSaveReceipt} from './task-save.mjs';
import {blankReplyForm,replyPolicyInput} from './reply-policy-ui.mjs';
test('reply policy exact pending receipt survives reload, scoped by owner and task',async()=>{
 const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)},scope='a'.repeat(64);
 const store=new ReplyPolicyReceiptStore(storage,scope,'task-1'),receipt=new TaskSaveReceipt(()=> 'reply-key',store);
 const form={...blankReplyForm(),mode:'review',target_id:'conversation-1',topic:'Public updates'},policy=replyPolicyInput(form);
 assert.deepEqual(replyPolicyInput(replyFormFromPolicy(policy)),policy);
 const body={expected_version:3,policy};let original;
 await assert.rejects(receipt.submit(async(...args)=>{original=args;throw new Error('lost response');},'/persistent-tasks/task-1/reply-policy','PATCH',body));
 body.policy={mode:'report'};
 const recovered=new TaskSaveReceipt(()=> 'different-key',new ReplyPolicyReceiptStore(storage,scope,'task-1'));
 await recovered.submit(async(...args)=>{assert.deepEqual(args,original);return {};},'ignored','PATCH',{});
 assert.equal(store.read(),null);
 assert.equal(new ReplyPolicyReceiptStore(storage,'b'.repeat(64),'task-1').read(),null);
 assert.equal(new ReplyPolicyReceiptStore(storage,scope,'task-2').read(),null);
 await assert.rejects(receipt.submit(async()=>{throw Object.assign(new Error('conflict'),{status:409});},'/persistent-tasks/task-1/reply-policy','PATCH',{expected_version:3,policy:{mode:'report'}}));
 assert.equal(receipt.pending,false);assert.equal(store.read(),null);
});
test('reply receipt rejects malformed authority, version and path before storage or request',()=>{
 const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
 const store=new ReplyPolicyReceiptStore(storage,'a'.repeat(64),'task-1');
 const command={path:'/persistent-tasks/task-1/reply-policy',method:'PATCH',key:'key',body:{expected_version:0,policy:{mode:'report'}}};
 for(const value of [{...command,path:'/persistent-tasks/task-2/reply-policy'},{...command,body:{...command.body,owner_id:'forged'}},{...command,body:{...command.body,expected_version:-1}},{...command,body:{...command.body,policy:{mode:'report',target:{}}}}])assert.throws(()=>store.saveCommand(value));
 store.saveCommand(command);data.set(store.key,'{"command":{"body":{"owner_id":"forged"}}}');assert.throws(()=>store.read());
});
