import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const output=new URL('../../.test-tmp/work-review-view/',import.meta.url);await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./TaskWorkReview.tsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:new URL('view.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {default:View}=await import(new URL('view.mjs',output));
test('work review renders frozen versions, rename and original objective as escaped non-executable text',()=>{
 const entries=Array.from({length:55},(_,i)=>({path:`report-${i}.md`,kind:'file',sha256:'a'.repeat(64),bytes:8,executable:false}));
 const value={selected_objective:'<script>unsafe()</script>',inspection_sha256:'b'.repeat(64),base_manifest:{entries},result_manifest:{entries},
  diff:{base_sha256:'c'.repeat(64),result_sha256:'d'.repeat(64),diff_sha256:'e'.repeat(64),changes:[{kind:'rename',from:'old.md',path:'new.md'}]}};
 const html=renderToStaticMarkup(React.createElement(View,{value}));
 assert.match(html,/尚未发布到项目/);assert.match(html,/old.md → new.md/);assert.match(html,/原始版本完整清单（55 项）/);assert.match(html,/结果版本完整清单（55 项）/);
 assert.match(html,/&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script/);assert.match(html,/下一页/);
 assert.doesNotMatch(html,/report-54\.md/);assert.match(html,/report-49\.md/);
});
