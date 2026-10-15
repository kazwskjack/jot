import test from 'node:test';
import assert from 'node:assert/strict';
import {bindingFailureSummary} from '../index.js';
test('goal status diagnostics retain only fixed stage and allow-listed state errors',()=>{
 assert.deepEqual(bindingFailureSummary('goal-status',new Error('workbench_task_state_invalid')),{stage:'goal-status',code:'workbench_task_state_invalid'});
 assert.deepEqual(bindingFailureSummary('goal-status',new Error('private credential content')),{stage:'goal-status',code:'workbench_binding_failed'});
});
import {stepFailureCode} from '../workbench.js';
test('step diagnostics whitelist budget failures and exclude arbitrary errors',()=>{
 assert.equal(stepFailureCode(new Error('budget_route_unavailable')),'budget_route_unavailable');
 assert.equal(stepFailureCode(new Error('secret page content')),'workbench_step_failed');
});
test('binding diagnostics retain fixed failure stage and exclude arbitrary remote messages',()=>{
 assert.deepEqual(bindingFailureSummary('attach',new Error('workbench_goal_unavailable')),{stage:'attach',code:'workbench_goal_unavailable'});
 assert.deepEqual(bindingFailureSummary('model-select',new Error('workbench_model_host_incompatible')),{stage:'model-select',code:'workbench_model_host_incompatible'});
 const error=new Error('private credential and page contents');error.cause=new Error('private owner');
 assert.deepEqual(bindingFailureSummary('attach',error),{stage:'attach',code:'workbench_binding_failed'});
});
