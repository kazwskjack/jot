import test from 'node:test';import assert from 'node:assert/strict';
import {validateConversationGoalView} from '../../src/harness/conversation-goal-view.ts';
const goal={id:'native-goal',revision:1,objective:'Finish the synthetic task',phase:'active',activation:'armed'};
test('native Goal enums are exact strings, never coercible arrays or objects',()=>{
 for(const field of ['phase','activation'])for(const value of [[goal[field]],{value:goal[field]},null,1])assert.throws(()=>validateConversationGoalView({goal:{...goal,[field]:value}}),/conversation_goal_state_invalid/);
 assert.deepEqual(validateConversationGoalView({goal}),{goal});
});
