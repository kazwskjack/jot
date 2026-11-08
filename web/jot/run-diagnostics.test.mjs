import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {diagnosticView,loadRunDiagnostics} from './run-diagnostics.mjs';
const compiled=await build({entryPoints:[fileURLToPath(new URL('./RunDiagnostics.tsx',import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs',packages:'external'});
const module={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const {RuntimeDiagnosticFacts}=module.exports;
const scope='a'.repeat(64),run={run_id:'run/a',conversation_id:'chat'};
const fixture=()=>({schema_version:1,run_id:'run/a',status:'succeeded',queue_ms:2000,preparation:{total_ms:120,outcome:'succeeded',phases:[{phase:'opening_snapshot',duration_ms:80,outcome:'succeeded',offset_ms:0}]},attempts:[{attempt_id:'a1',state:'settled',provider:'PRIVATE_ENDPOINT',model:'PRIVATE_MODEL',retry_index:0,ttft_ms:300,generation_ms:1000,usage_status:'available',usage:{input_tokens:'20',output_tokens:'5',cache_read_tokens:'10',cache_write_tokens:'2',total_tokens:'37'},cost:{nano_usd:'47',basis:'configured_rates'},unknown:false,manual_intervention_required:false,missing:[]}],retry_count:0,manual_intervention_required:false,partial:false,missing:[]});

test('diagnostic caller checks the original conversation and owner before presenting the existing route',async()=>{
 const calls=[],request=async(path,method,body,key,signal)=>{calls.push({path,method,signal});if(path.endsWith('/diagnostics'))return fixture();if(path==='/capabilities')return{};return run;};
 const abort=new AbortController(),view=await loadRunDiagnostics(request,()=>scope,run,abort.signal);
 assert.deepEqual(calls.map(c=>c.path),['/runs/run%2Fa','/runs/run%2Fa/diagnostics','/capabilities']);
 assert.ok(calls.every(c=>c.method==='GET'&&c.signal===abort.signal));assert.equal(view.queue_ms,2000);assert.equal(view.calls[0].ttft_ms,300);
});

test('diagnostic caller rejects a foreign conversation before reading its diagnostic projection',async()=>{
 const calls=[];
 await assert.rejects(()=>loadRunDiagnostics(async path=>{calls.push(path);return{...run,conversation_id:'foreign'};},()=>scope,run,new AbortController().signal),/诊断目标/);
 assert.deepEqual(calls,['/runs/run%2Fa']);
});

test('diagnostic caller suppresses a late result after owner scope changes',async()=>{
 let current=scope;const calls=[];
 await assert.rejects(()=>loadRunDiagnostics(async path=>{calls.push(path);if(path==='/capabilities'){current='b'.repeat(64);return{};}return path.endsWith('/diagnostics')?fixture():run;},()=>current,run,new AbortController().signal),/用户范围/);
 assert.equal(calls.at(-1),'/capabilities');
});

test('diagnostic caller aborts on conversation disposal without returning a late report',async()=>{
 const abort=new AbortController(),calls=[];
 await assert.rejects(()=>loadRunDiagnostics(async path=>{calls.push(path);if(path.endsWith('/diagnostics')){abort.abort();return fixture();}return run;},()=>scope,run,abort.signal),e=>e.name==='AbortError');
 assert.equal(calls.includes('/capabilities'),false);
});

test('diagnostic view preserves missing timing and caches and does not classify later calls as retries',()=>{
 const raw=fixture();raw.attempts.push({...raw.attempts[0],attempt_id:'a2',retry_index:1,state:'unknown',usage_status:'partial',usage:{output_tokens:'9007199254740993'},cost:null,ttft_ms:null,generation_ms:null,unknown:true,manual_intervention_required:true});raw.retry_count=1;
 const view=diagnosticView(raw,run.run_id);
 assert.equal(view.dispatched_calls,2);assert.equal(view.retry_status,'unknown');assert.equal(view.calls[1].usage.output_tokens,'9007199254740993');assert.equal(view.calls[1].usage.cache_read_tokens,null);assert.equal(view.calls[1].ttft_ms,null);assert.equal(view.calls[1].cost,null);assert.equal(view.manual_intervention_required,true);
 assert.doesNotMatch(JSON.stringify(view),/PRIVATE_ENDPOINT|PRIVATE_MODEL|attempt_id|a2/);
 assert.throws(()=>diagnosticView({...raw,run_id:'other'},run.run_id),/诊断目标/);
});

test('diagnostic panel renders recorded preparation, first body, cache and estimated cost without treating absence as zero',()=>{
 const raw=fixture(),view=diagnosticView(raw,run.run_id);
 const html=renderToStaticMarkup(React.createElement(RuntimeDiagnosticFacts,{view}));
 assert.match(html,/2000 ms/);assert.match(html,/120 ms/);assert.match(html,/首段正文/);assert.match(html,/300 ms/);assert.match(html,/Cache 读取/);assert.match(html,/配置费率估算/);assert.match(html,/0\.000000047/);assert.match(html,/重试次数.*未确认/);assert.doesNotMatch(html,/PRIVATE/);
 raw.queue_ms=null;raw.preparation.total_ms=null;raw.attempts[0].ttft_ms=null;raw.attempts[0].usage={};raw.attempts[0].cost=null;
 const missing=renderToStaticMarkup(React.createElement(RuntimeDiagnosticFacts,{view:diagnosticView(raw,run.run_id)}));assert.match(missing,/未记录/);assert.doesNotMatch(missing,/>0 ms</);
});

test('diagnostic labels reject prototype keys and unknown status text',()=>{
 const raw=fixture();raw.attempts[0].state='toString';raw.preparation.phases[0].outcome='constructor';
 const view=diagnosticView(raw,run.run_id);assert.equal(view.calls[0].state,'状态未确认');assert.equal(view.phases[0].outcome,'结果未确认');
});

test('diagnostic panel distinguishes partial and unknown usage for each attempt',()=>{
 const raw=fixture();raw.attempts[0].usage_status='partial';raw.attempts[0].usage={input_tokens:'20'};
 raw.attempts.push({...raw.attempts[0],attempt_id:'a2',retry_index:1,state:'unknown',usage_status:'unknown',usage:null,unknown:true,manual_intervention_required:true});
 const view=diagnosticView(raw,run.run_id),html=renderToStaticMarkup(React.createElement(RuntimeDiagnosticFacts,{view}));
 assert.equal(view.calls[0].usage_status,'partial');assert.equal(view.calls[1].usage_status,'unknown');
 assert.match(html,/用量状态/);assert.match(html,/部分记录/);assert.match(html,/未确认/);
 assert.match(html,/未记录/);assert.doesNotMatch(html,/PRIVATE|attempt_id|a2/);
});
