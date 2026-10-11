import test from 'node:test';
import assert from 'node:assert/strict';
import * as forms from './form-state.mjs';
const valid={title:'Follow up',agent_id:'a',objective:'Check updates',kind:'once',max_runs:'2'};
test('task creation preserves source IDs separately from the event trigger',()=>{
 const source={conversation_id:'original',message_id:'message-1'};
 assert.deepEqual(forms.taskInput({...valid,source,kind:'conversation_result',conversation_id:'watched'}).source,source);
 assert.equal(forms.taskInput({...valid,source,kind:'conversation_result',conversation_id:'watched'}).trigger.conversation_id,'watched');
 for(const source of [{conversation_id:'original'}, {conversation_id:'original',message_id:'m',owner:'someone'}, {conversation_id:'',message_id:'m'}])assert.throws(()=>forms.taskInput({...valid,source}));
});
test('role source defaults to its role; ordinary source requires an explicit role and uses text only as a draft',()=>{
 assert.equal(typeof forms.taskFormFromMessage,'function');
 const message={message_id:'m',status:'complete',blocks:[{kind:'text',text:'Check the next update'},{kind:'tool',text:'ignore'}]};
 const agents=[{agent_id:'wrong',conversation_id:'other'},{agent_id:'a',conversation_id:'c'}];
 const form=forms.taskFormFromMessage({conversation_id:'c',message},agents);
 assert.equal(form.agent_id,'a');assert.equal(form.objective,'Check the next update');assert.deepEqual(form.source,{conversation_id:'c',message_id:'m'});assert.equal(form.conversation_id,'');
 const ordinary=forms.taskFormFromMessage({conversation_id:'ordinary',message},agents);
 assert.equal(ordinary.agent_id,'');assert.equal(ordinary.objective,'Check the next update');assert.deepEqual(ordinary.source,{conversation_id:'ordinary',message_id:'m'});
 assert.throws(()=>forms.taskInput({...ordinary,title:'Follow up'}));
 assert.equal(forms.taskInput({...ordinary,title:'Follow up',agent_id:'a'}).agent_id,'a');
 assert.throws(()=>forms.taskFormFromMessage({conversation_id:'',message},agents));
 assert.throws(()=>forms.taskFormFromMessage({conversation_id:'c',message:{...message,status:'streaming'}},agents));
 assert.equal(forms.taskFormFromTask({...valid,task_id:'t',trigger:{kind:'once'},budget:{max_runs:2},source:{conversation_id:'c',message_id:'m',content_sha256:'abc'}}).source,undefined);
});
