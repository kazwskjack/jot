import test from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {build} from 'esbuild';import {mkdir} from 'node:fs/promises';
const output=new URL('../../.test-tmp/discovery-policy-panel-tests/',import.meta.url);await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./DiscoveryPolicyPanel.tsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',external:['react','react-dom'],outfile:new URL('panel.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {DiscoveryPolicySettings}=await import(new URL('panel.mjs',output));
const agent={agent_id:'reader',workspace_id:'shared',project_id:'project',name:'研究员',status:'active',version:3,capability_epoch:2};
const policy={policy_id:'policy',scope:{agent_id:'reader',workspace_id:'shared',project_id:'project'},version:4,role_version:3,role_epoch:2,state:'paused',effective_state:'paused',mode:'discover_only',cooldown_ms:300000,recent_input_ms:60000,max_cycles:null,execution_authorized:false};
const render=(change={})=>renderToStaticMarkup(React.createElement(DiscoveryPolicySettings,{agent,policy:null,form:{cooldown_seconds:'300',recent_input_seconds:'60',max_cycles:''},ready:true,busy:false,pending:false,onChange:()=>{},onSave:()=>{},onControl:()=>{},...change}));
test('unsaved discovery settings visibly stay off, make no execution promise and have no enable control',()=>{
 const html=render();for(const text of ['默认关闭','只提出方案','尚未安装自动发现调度','保存策略','不限次数'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/>立即运行<|>启用策略<|>停止策略</);
});
test('saved policy exposes separate explicit lifecycle controls; revoked role cannot resume before review',()=>{
 const paused=render({policy});assert.match(paused,/>恢复策略</);assert.match(paused,/>停止策略</);assert.match(paused,/策略版本 4/);
 const revoked=render({policy:{...policy,effective_state:'revoked'},agent:{...agent,version:4}});assert.match(revoked,/角色权限已变化/);assert.match(revoked,/<button[^>]*disabled=""[^>]*>重新启用策略</);
 const active=render({policy:{...policy,state:'active',effective_state:'active'}});assert.match(active,/>暂停策略</);assert.doesNotMatch(active,/>恢复策略</);
});
test('unknown request outcome locks fields and new commands until the original receipt is retried',()=>{
 const html=render({policy,pending:true});assert.match(html,/<fieldset[^>]*disabled=""/);assert.doesNotMatch(html,/>恢复策略</);assert.doesNotMatch(html,/>停止策略</);assert.match(html,/原请求结果待确认/);
});
