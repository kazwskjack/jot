import test from 'node:test';
import assert from 'node:assert/strict';
import {dollarsToNano,nanoToDollars,budgetLimitInput,budgetReason,budgetError} from './budget-ui.mjs';
test('budget dollars preserve every nano-dollar without floating point rounding',()=>{
 assert.equal(dollarsToNano('0.000000001'),1);assert.equal(dollarsToNano('0.29'),290000000);
 assert.equal(nanoToDollars('9007199254740991'),'9007199.254740991');assert.equal(dollarsToNano('9007199.254740991'),Number.MAX_SAFE_INTEGER);
 assert.equal(nanoToDollars('90'),'0.00000009');assert.equal(nanoToDollars('0'),'0');
 for(const value of ['-1','1e3','Infinity','NaN','0.0000000001','9007199.254740992','', '1,000'])assert.throws(()=>dollarsToNano(value));
});
test('limit form accepts exact integers only and does not silently clamp expense or counts',()=>{
 assert.deepEqual(budgetLimitInput({tokens:'200',dollars:'0.000002',model_calls:'2'}),{tokens:200,nano_usd:2000,model_calls:2});
 for(const value of ['1.5','1e3','-1','Infinity','9007199254740992',''])assert.throws(()=>budgetLimitInput({tokens:value,dollars:'0',model_calls:'2'}));
 assert.throws(()=>budgetLimitInput({tokens:'1',dollars:'0',model_calls:'0.1'}));
});
test('budget reasons and errors expose user actions without machine paths or model internals',()=>{
 assert.match(budgetReason('task_total:model_calls'),/任务.*次数/);assert.match(budgetReason('usage_unknown'),/用量.*确认/);
 assert.match(budgetError('BUDGET_LIMIT_BELOW_COMMITMENT'),/已消耗.*预留/);assert.match(budgetError('BUDGET_LIMIT_VERSION_CONFLICT'),/刷新/);
 assert.doesNotMatch(budgetError('E:/private/key.txt'),/private|key.txt/);assert.doesNotMatch(budgetReason('internal_scope_id'),/internal_scope_id/);
});
