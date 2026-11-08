import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const output=fileURLToPath(new URL('../../.test-tmp/host-settings-panel-recovery/',import.meta.url));
await mkdir(output,{recursive:true});
await build({entryPoints:[fileURLToPath(new URL('./HostSettingsPanel.tsx',import.meta.url))],bundle:true,format:'esm',platform:'node',external:['react'],outfile:join(output,'HostSettingsPanel.mjs'),logLevel:'silent'});
const {default:HostSettingsPanel}=await import(new URL('../../.test-tmp/host-settings-panel-recovery/HostSettingsPanel.mjs',import.meta.url));

test('unknown write outcome exposes same-key recovery and keeps the credential reference hidden',()=>{
 const callbacks=[];
 const settings={mode:'agent',workspace_id:'workspace-a',provider_id:'provider-a',model_id:'model-a',credential_ref:'opaque-reference-must-not-render',voice_provider_id:null,plugin_selection:[]};
 const html=renderToStaticMarkup(React.createElement(HostSettingsPanel,{
  enabled:true,
  state:{snapshot:{settings_version:7,schema_version:2,schema_fingerprint:'f'.repeat(64),write_scope:'a'.repeat(64),settings},draft:settings,loading:false,saving:false,dirty:true,conflict:false,unknownPending:true,error:'Host 尚未确认；再次点击“查询保存状态”会复用同一保存键。',notice:'',activation:null},
  readiness:null,
  onDraftChange:value=>callbacks.push(['draft',value]),onUseHostValues:()=>callbacks.push(['use']),onReload:()=>callbacks.push(['reload']),onSave:()=>callbacks.push(['recover'])
 }));
 assert.match(html,/<button class="wb-primary" type="button">查询保存状态<\/button>/);
 assert.match(html,/尚未确认/);
 assert.match(html,/disabled/);
 assert.equal(html.includes('opaque-reference-must-not-render'),false);
 assert.equal(callbacks.length,0,'static render does not invoke controlled callbacks');
});
