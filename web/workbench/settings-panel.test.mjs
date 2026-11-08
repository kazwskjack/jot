import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const output=fileURLToPath(new URL('../../.test-tmp/settings-panel-test/',import.meta.url));
await mkdir(output,{recursive:true});
await build({entryPoints:[fileURLToPath(new URL('./SettingsPanel.tsx',import.meta.url))],bundle:true,format:'esm',platform:'node',external:['react'],outfile:join(output,'SettingsPanel.mjs')});
const {default:SettingsPanel}=await import(new URL('../../.test-tmp/settings-panel-test/SettingsPanel.mjs',import.meta.url));
const client={readiness:async()=>null,settings:async()=>null,saveSettings:async()=>null,onboarding:async()=>null,saveOnboarding:async()=>null};

test('settings view labels catalog evidence separately and hides secret fields',()=>{
 const caps={
  models:[{provider:'provider-a',model:'model-a',api_key:'never-render-this'}],
  workbench:{enabled:false,execution_ready:true},
 };
 const html=renderToStaticMarkup(React.createElement(SettingsPanel,{caps,client}));
 assert.match(html,/Host readiness capability 未开放；状态未知/);
 assert.match(html,/运行时状态/);
 assert.match(html,/model-a/);
 assert.match(html,/不代表凭据有效、模型调用已验证或 RuntimeReadiness 已就绪/);
 assert.match(html,/版本化设置接口未开放/);
 assert.match(html,/安装引导接口未开放/);
 assert.equal(html.includes('never-render-this'),false);
 assert.equal(/<input\b|<form\b|<button\b/i.test(html),false);
});

test('settings page never infers Host runtime readiness from legacy capability flags and keeps Host APIs unavailable by default',()=>{
 const caps={capabilities:{browser_interaction:true},workbench:{execution_ready:true},models:[{provider:'provider-a',model:'model-a'}]};
 const html=renderToStaticMarkup(React.createElement(SettingsPanel,{caps,client}));
 assert.match(html,/Host readiness capability 未开放；状态未知/);
 assert.match(html,/未知/);
 assert.doesNotMatch(html,/Workbench 执行/);
 assert.match(html,/版本化设置接口未开放/);
 assert.match(html,/安装引导接口未开放/);
 assert.equal(/<input\b|<form\b/i.test(html),false);
});

test('Host settings.read is exposed as an explicit read-only approval flow, separate from legacy settings mutation',()=>{
 const caps={models:[],workbench:{enabled:true,host_settings:false,host_settings_read:true,host_settings_read_namespaces:['agent-default-model']}};
 const html=renderToStaticMarkup(React.createElement(SettingsPanel,{caps,client}));
 assert.match(html,/批准并连接 Host/);
 assert.match(html,/仅读取获批 namespace/);
 assert.match(html,/版本化设置接口未开放/);
 assert.doesNotMatch(html,/保存宿主设置/);
});
