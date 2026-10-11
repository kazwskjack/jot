import test from 'node:test';
import assert from 'node:assert/strict';
import {blankTaskForm,taskTriggerInput,taskFormFromTask,taskTriggerSummary} from './form-state.mjs';
test('dialogue forms save only public conversation identity and restore the selected event',()=>{
 const form={...blankTaskForm('agent-a'),kind:'conversation_result',conversation_id:'conversation-a'};
 assert.deepEqual(taskTriggerInput(form),{kind:'conversation_result',conversation_id:'conversation-a'});
 assert.equal(taskFormFromTask({agent_id:'agent-a',title:'Follow',objective:'Observe',trigger:{kind:'conversation_message',conversation_id:'conversation-b'},budget:{max_runs:5}}).conversation_id,'conversation-b');
 assert.match(taskTriggerSummary({kind:'conversation_result'}),/对话.*结果/);
 assert.throws(()=>taskTriggerInput({...form,conversation_id:''}),/对话/);
});
