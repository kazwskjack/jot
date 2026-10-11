import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
const output=new URL('../../.test-tmp/budget-panel-tests/',import.meta.url);await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./TaskBudgetPanel.tsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',external:['react','react-dom'],outfile:new URL('panel.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {BudgetDetails}=await import(new URL('panel.mjs',output));
const amounts=value=>({tokens:String(value),nano_usd:String(value),model_calls:String(value)});
test('budget display separates actual spend, pending holds and shared ceilings without fake provider billing',()=>{
 const scope={kind:'task_total',limits:amounts(500),used:amounts(90),held:amounts(100),remaining:amounts(310),starts_at:null,ends_at:null};
 const view={configured:true,task_id:'t',version:2,root:scope,ceiling:amounts(5000),shared:[{...scope,kind:'owner_daily'}],can_start_next_call:false,blocking_reasons:['usage_unknown'],pending_unknown:1,token_accounting:'metered_routes_only',unmetered_token_calls:3,cost_basis:'configured_rates',currency:'USD',as_of:'2026-10-02T00:00:00Z'};
 const html=renderToStaticMarkup(React.createElement(BudgetDetails,{budget:view,onEdit:()=>{},busy:false}));
 for(const text of ['已消耗','预留中','可用','0.00000009','用量尚待确认','每日共享额度','按配置费率核算'])assert.ok(html.includes(text),text);
 assert.match(html,/调整额度/);assert.doesNotMatch(html,/免费|供应商账单已确认/);
 assert.match(html,/已计量 Token/);assert.match(html,/按次数计量的辅助调用：3 次/);assert.match(html,/不代表 Token 用量为零/);
});
test('unconfigured budget renders unavailable rather than zero spend and no adjust control',()=>{
 const html=renderToStaticMarkup(React.createElement(BudgetDetails,{budget:{configured:false,task_id:'t',reason:'BUDGET_POLICY_NOT_CONFIGURED'},onEdit:()=>{},busy:false}));
 assert.match(html,/尚未启用模型预算/);assert.doesNotMatch(html,/调整额度|已消耗/);
});
