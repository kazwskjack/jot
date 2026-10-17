import test from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {build} from 'esbuild';import {mkdir} from 'node:fs/promises';
const output=new URL('../../.test-tmp/file-list-panel-tests/',import.meta.url);await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./SharedWorkspace.tsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',external:['react','react-dom'],outfile:new URL('panel.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {WorkspaceFileListing}=await import(new URL('panel.mjs',output));
const render=page=>renderToStaticMarkup(React.createElement(WorkspaceFileListing,{page,disabled:false,onOpen(){},onMore(){},onRefresh(){}}));
test('file UI renders every loaded path and offers explicit continuation until the last page',()=>{
 const items=Array.from({length:405},(_,i)=>({path:i===404?'<script>bad</script>':`file-${i}.txt`,version:1,size:1,sha256:'a'.repeat(64)}));
 const html=render({items,next_cursor:'next',loading:false,error:''});assert.match(html,/已加载 405 个文件/);assert.match(html,/加载更多文件/);assert.match(html,/file-403.txt/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.doesNotMatch(render({items,next_cursor:null,loading:false,error:''}),/加载更多文件/);
 assert.match(render({items,next_cursor:'next',loading:true,error:''}),/disabled=""/);
});
