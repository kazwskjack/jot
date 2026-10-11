import test from 'node:test';import assert from 'node:assert/strict';
import {blankReplyForm,replyPolicyInput,validateReplyForm,validateFrozenReplyPolicy} from './reply-policy-ui.mjs';
import {blankTaskForm,taskInput,validateTaskWizardStep} from './form-state.mjs';import {TaskDraftStore} from './task-save.mjs';
test('reply forms default to report and preserve a bounded explicit target without extra authority',()=>{
 const form=blankReplyForm();assert.deepEqual(replyPolicyInput(form),{mode:'report'});
 const bounded={...form,mode:'bounded_auto_reply',target_id:'own-conversation',topic:'Release notes',expires_at:'2099-01-01T00:00:00Z'};
 assert.throws(()=>replyPolicyInput(bounded),/有效期/);bounded.expires_at=new Date(Date.now()+86400000).toISOString();const policy=replyPolicyInput(bounded);assert.equal(policy.target.conversation_id,'own-conversation');assert.equal(policy.direction.evidence_required,true);
 assert.throws(()=>validateReplyForm({...bounded,owner_id:'bob'}));assert.throws(()=>replyPolicyInput({...bounded,max_per_24_hours:'21'}));assert.throws(()=>replyPolicyInput({...bounded,target_id:''}));
 assert.throws(()=>validateFrozenReplyPolicy({...policy,direction:{...policy.direction,evidence_required:false}}));
});
test('partial reply drafts persist, confirmed creation freezes exact policy and expired receipts remain recoverable',()=>{
 const memory=new Map(),storage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};const store=new TaskDraftStore(storage,'b'.repeat(64));
 const form={...blankTaskForm('agent'),title:'Follow up',objective:'Collect notes',reply_settings:{...blankReplyForm(),mode:'draft',topic:''}};store.saveDraft(form,null,3);assert.deepEqual(store.read().form.reply_settings,form.reply_settings);assert.throws(()=>taskInput(form));
 assert.doesNotThrow(()=>validateTaskWizardStep(form,2));assert.throws(()=>validateTaskWizardStep(form,3));
 form.reply_settings.topic='Release notes';form.reply_settings.target_id='own-conversation';form.reply_settings.expires_at=new Date(Date.now()+86400000).toISOString();const body=taskInput(form);assert.equal(body.reply_policy.mode,'draft');store.saveDraft(form,null,4);store.saveCommand({path:'/persistent-tasks',method:'POST',body,key:'original-reply-key'});assert.deepEqual(new TaskDraftStore(storage,'b'.repeat(64)).read().command.body.reply_policy,body.reply_policy);
 const frozen={...body.reply_policy,limits:{...body.reply_policy.limits,expires_at:'2020-01-01T00:00:00Z'}};validateFrozenReplyPolicy(frozen);store.saveCommand({path:'/persistent-tasks',method:'POST',body:{...body,reply_policy:frozen},key:'test-expired-retry'});assert.equal(store.read().command.key,'test-expired-retry');
});
