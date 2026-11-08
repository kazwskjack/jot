import test from 'node:test';import assert from 'node:assert/strict';
import {blankTaskForm,taskInput,taskFormFromTask,validateTaskWizardStep,taskCreationNotificationDraft,taskCreationNotificationDefaults} from './form-state.mjs';
import {TaskDraftStore} from './task-save.mjs';
test('new task defaults to in-app delivery and review strips local binding versions from the request',()=>{
 const form={...blankTaskForm('agent'),title:'Notify',objective:'Watch updates'};
 assert.deepEqual(taskInput(form).notification_settings,{channel_binding_ids:[],artifact_delivery_binding_ids:[],events:['completed']});
 form.notification_settings={channel_binding_ids:['verified-wecom'],artifact_delivery_binding_ids:['verified-wecom'],artifact_delivery_binding_versions:{'verified-wecom':7},events:['completed','failed']};const request=taskInput(form);
 assert.deepEqual(request.notification_settings,{channel_binding_ids:['verified-wecom'],artifact_delivery_binding_ids:['verified-wecom'],events:['completed','failed']});form.notification_settings.channel_binding_ids.push('changed');form.notification_settings.artifact_delivery_binding_ids.push('changed');assert.deepEqual(request.notification_settings.channel_binding_ids,['verified-wecom']);assert.deepEqual(request.notification_settings.artifact_delivery_binding_ids,['verified-wecom']);
 for(const invalid of [{channel_binding_ids:['x','x'],events:['completed']},{channel_binding_ids:['x'],events:['send_anywhere']},{channel_binding_ids:[],events:['completed'],recipient:'a@example.test'},{channel_binding_ids:['x'],artifact_delivery_binding_ids:['foreign'],events:['completed']},{channel_binding_ids:['x'],artifact_delivery_binding_ids:['x'],events:['failed']}])assert.throws(()=>taskInput({...form,notification_settings:invalid}));
 assert.equal(taskInput(taskFormFromTask({task_id:'t',title:'Old',agent_id:'agent',objective:'Goal',trigger:{kind:'once'},budget:{max_runs:1}})).notification_settings,undefined);
 validateTaskWizardStep({...form,notification_settings:{channel_binding_ids:[],artifact_delivery_binding_ids:[],events:['completed']}},4);
});
test('final delivery review and exact unknown-create payload survive same-tab draft recovery',()=>{
 const memory=new Map(),storage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};
 const store=new TaskDraftStore(storage,'a'.repeat(64)),form={...blankTaskForm('agent'),title:'Notify',objective:'Watch updates',notification_settings:{channel_binding_ids:['verified-wecom'],artifact_delivery_binding_ids:['verified-wecom'],artifact_delivery_binding_versions:{'verified-wecom':7},events:['completed','failed']}};
 store.saveDraft(form,null,4);const body=taskInput(form);store.saveCommand({path:'/persistent-tasks',method:'POST',body,key:'original-key'});
 const recovered=new TaskDraftStore(storage,'a'.repeat(64)).read();assert.equal(recovered.step,4);assert.deepEqual(recovered.command.body.notification_settings,body.notification_settings);assert.deepEqual(recovered.form.notification_settings,form.notification_settings);
});

test('legacy task notification drafts normalize absent file consent before the wizard reads selections',()=>{
 const legacy={channel_binding_ids:['verified-wecom'],events:['completed']};
 const normalized=taskCreationNotificationDraft(legacy);
 assert.deepEqual(normalized,{channel_binding_ids:['verified-wecom'],artifact_delivery_binding_ids:[],artifact_delivery_binding_versions:{},events:['completed']});
 assert.deepEqual(taskCreationNotificationDefaults(legacy),normalized);
 assert.deepEqual(legacy,{channel_binding_ids:['verified-wecom'],events:['completed']});
});
