import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';

const output=new URL('../../.test-tmp/retryable-panel-tests/',import.meta.url);
await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./RetryablePanel.tsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',external:['react','react-dom'],outfile:new URL('panel.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {RetryablePanel,PanelStatus}=await import(new URL('panel.mjs',output));

test('panel chunk loading uses an accessible status with its view name',()=>{
 const html=renderToString(React.createElement(RetryablePanel,{load:()=>new Promise(()=>{}),label:'Git 工作台',props:{}}));
 assert.match(html,/role="status"/);assert.match(html,/正在加载 Git 工作台/);
});

test('panel status exposes a retry action when a resource failed',()=>{
 let retried=false;
 const html=renderToString(React.createElement(PanelStatus,{loading:false,error:'chunk failed',onRetry:()=>{retried=true},label:'Git 工作台'}));
 assert.match(html,/role="alert"/);assert.match(html,/chunk failed/);assert.match(html,/重新加载 Git 工作台/);
 assert.equal(retried,false);
});
