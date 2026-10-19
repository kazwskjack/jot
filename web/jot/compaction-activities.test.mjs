import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
let CompactionActivities;
try{const result=await build({entryPoints:[fileURLToPath(new URL('./CompactionActivities.tsx',import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',logLevel:'silent'});const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);CompactionActivities=module.exports.default;}catch(e){if(!String(e).includes('Could not resolve'))throw e;}
const activity={activity_id:'compact',run_id:'run',kind:'compaction',status:'running',title:'PRIVATE TITLE',started_at:'2026-10-19T00:00:00Z',detail:{compaction_id:'native',phase:'start',summary:'PRIVATE SUMMARY'}};
const render=(activities=[activity],runs={run:{status:'running'}})=>renderToStaticMarkup(React.createElement(CompactionActivities,{activities,runs}));
test('native compaction renders fixed live and terminal labels without raw details',()=>{
 assert.equal(typeof CompactionActivities,'function');let html=render();assert.match(html,/正在压缩上下文/);assert.match(html,/aria-busy="true"/);assert.doesNotMatch(html,/PRIVATE|SUMMARY|TITLE/);
 html=render([{...activity,status:'succeeded',detail:{compaction_id:'native',phase:'end'},ended_at:'2026-10-19T00:00:03Z'}]);assert.match(html,/上下文已整理/);assert.doesNotMatch(html,/aria-busy="true"/);
 html=render([{...activity,status:'failed'}]);assert.match(html,/上下文整理失败/);
});
test('missing native end never claims success when the run terminates; tool activities are untouched',()=>{
 assert.equal(typeof CompactionActivities,'function');for(const status of ['succeeded','failed','interrupted','partial']){const html=render([activity],{run:{status}});assert.match(html,/上下文整理状态待确认/);assert.doesNotMatch(html,/上下文已整理|正在压缩上下文/);}
 assert.match(render([activity],{run:{status:'cancelled'}}),/上下文整理已取消/);assert.equal(render([{...activity,kind:'command'}]),'');
});
