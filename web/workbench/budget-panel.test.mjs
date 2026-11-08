import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
const output=new URL('../../.test-tmp/budget-panel-tests/',import.meta.url);await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./TaskBudgetPanel.tsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',external:['react','react-dom'],outfile:new URL('panel.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {BudgetDetails,BudgetAttemptHistory}=await import(new URL('panel.mjs',output));
const amounts=value=>({tokens:String(value),nano_usd:String(value),model_calls:String(value)});
function findButton(value,label){
 if(Array.isArray(value)){for(const item of value){const found=findButton(item,label);if(found)return found;}return null;}
 if(!React.isValidElement(value))return null;
 if(value.type==='button'&&value.props['aria-label']===label)return value;
 return findButton(value.props.children,label);
}
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
test('attempt history distinguishes confirmed usage, unknown usage and configured-rate cost from invoices',()=>{
 const item=(attempt_ref,purpose,state,usage,settled)=>({attempt_ref,purpose,state,created_at:'2026-10-21T00:00:00.000Z',updated_at:'2026-10-21T00:00:01.000Z',reserved:{tokens:'100',nano_usd:'1000',model_calls:'1'},settled,cost_basis:'configured_rates',usage});
 const page={configured:true,task_id:'task',items:[
  item('a'.repeat(43),'compaction','settled',{status:'settled',input_tokens:'20',output_tokens:'5',cache_read_tokens:'10',cache_write_tokens:'5',reasoning_tokens:null,total_tokens:'40'},{tokens:'40',nano_usd:'115',model_calls:'1'}),
  item('c'.repeat(43),'reply-verification','settled',{status:'settled',input_tokens:null,output_tokens:'20',cache_read_tokens:'20',cache_write_tokens:null,reasoning_tokens:'5',total_tokens:'120'},{tokens:'120',nano_usd:'380',model_calls:'1'}),
  item('b'.repeat(43),'web-decision','unknown',{status:'unknown',input_tokens:null,output_tokens:null,cache_read_tokens:null,cache_write_tokens:null,reasoning_tokens:null,total_tokens:null},{tokens:null,nano_usd:null,model_calls:null})
 ],next_cursor:'2',truncated:true,cost_basis:'configured_rates',currency:'USD'};
 const html=renderToStaticMarkup(React.createElement(BudgetAttemptHistory,{page,onNext:()=>{}}));
 for(const text of ['调用记录','费用按配置费率核算（非供应商账单）','上下文压缩','回复核验','已结算','部分用量分桶未知','用量未知','不会按 0 估算','推理 Token','未知','加载更多调用','仍有后续记录未显示'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/供应商账单已确认|run_id|session_id|provider|bounded-model|fixture/);
 let requestedCursor=null;const tree=BudgetAttemptHistory({page,onNext:cursor=>{requestedCursor=cursor;}});
 findButton(tree,'加载更多调用')?.props.onClick();assert.equal(requestedCursor,'2');
});
