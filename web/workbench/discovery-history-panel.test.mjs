import test from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {build} from 'esbuild';import {mkdir} from 'node:fs/promises';
const output=new URL('../../.test-tmp/discovery-history-panel-tests/',import.meta.url);await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./DiscoveryHistory.tsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',external:['react','react-dom'],outfile:new URL('panel.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {DiscoveryCycleReport}=await import(new URL('panel.mjs',output));
const cycle={admission_id:'a',occurrence_id:'o',task_id:'t',signal_revision:3,created_at:'2026-10-17T00:00:00Z',run:{run_id:'r',status:'succeeded',business_state:'waiting_approval'},report:null,accepted:false};
const report={report_id:'report',sha256:'a'.repeat(64),outcome:'proposals',summary:'<img src=x onerror=alert(1)>',limitations:['<script>untrusted()</script>'],plan_ids:['p'],evidence:[],coverage:{signal_count:2,fully_read:1}};
const plan={plan_id:'p',sha256:'b'.repeat(64),summary:'<b>source summary</b>',rationale:'Source-backed proposal',changes:[{path:'notes.md',description:'Clarify notes',steps:['Review original'],verification:['Compare source']}],evidence:[]};
test('report preview safely renders proposals, limitations and coverage as untrusted text and preserves acceptance boundaries',()=>{
 const html=renderToStaticMarkup(React.createElement(DiscoveryCycleReport,{value:{cycle,report,plans:[plan],next_after_plan_id:null,execution_authorized:false}}));
 for(const text of ['执行已结束','等待审核','尚未验收','完整读取 1 / 2 条来源','提案，尚未应用','Clarify notes','Compare source'])assert.ok(html.includes(text),text);
 assert.match(html,/&lt;img/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<img|<script|<b>/);assert.doesNotMatch(html,/<button|自动批准|已修改项目/);
});
test('missing report and accepted history never turn original receipt readback into new execution authority',()=>{
 const html=renderToStaticMarkup(React.createElement(DiscoveryCycleReport,{value:{cycle:{...cycle,accepted:true},report:null,plans:[],next_after_plan_id:null,execution_authorized:false}}));
 assert.match(html,/原验收已完成/);assert.match(html,/尚无报告/);assert.match(html,/历史记录不会授予新的执行权限/);
});
