// Real React/browser interaction with synthetic read-only API responses.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve,join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'..'),output=join(root,'.test-tmp/work-review-ui');await mkdir(output,{recursive:true});
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Panel from './web/jot/TaskReviewFiles';import './web/workbench/workbench.css';let id='int-original';const root=createRoot(document.getElementById('root'));window.switchReview=()=>{id='int-next';render()};function render(){root.render(<Panel id={id} version={1} disabled={false} onRefresh={async()=>{}}/>)}render();`},bundle:true,write:false,outdir:output,format:'esm',logLevel:'silent'});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
const sha='a'.repeat(64),entries=Array.from({length:55},(_,i)=>({path:`report-${i}.md`,kind:'file',bytes:8,sha256:sha,executable:i===0}));
entries[0].path='reports/'+'x'.repeat(300)+'.md';
const inventory={protocol:1,provider:'snapshot-copy',paths:entries.map(e=>e.path),entries};
const work={protocol:1,source:'isolated',grant_id:'grant',work_occurrence_id:'occ',cycle_id:'cycle',snapshot_id:'snapshot',selected_objective:'<script>window.injected=true</script>',
 ...Object.fromEntries(['source_sha256','source_record_sha256','plans_sha256','paths_sha256','call_set_sha256','inspection_sha256'].map(k=>[k,sha])),base_manifest:inventory,result_manifest:inventory,
 diff:{protocol:1,base_sha256:sha,result_sha256:sha,diff_sha256:sha,changes:[{kind:'rename',from:'before.md',path:'after.md'}],execution_authorized:false},execution_authorized:false};
const reads=[],faults=[];
const server=createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('content-type','text/html;charset=utf-8');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/view.css"><main id="root"></main><script type="module" src="/view.js"></script>');return;}
 if(req.url==='/view.js'){res.setHeader('content-type','application/javascript');res.end(js);return;}
 if(req.url==='/view.css'){res.setHeader('content-type','text/css');res.end(css);return;}
 reads.push({method:req.method,path:req.url});res.setHeader('content-type','application/json');
 if(req.method==='GET'&&req.url==='/workbench-api/v1/interactions/int-original/outputs'){res.end(JSON.stringify({items:[],work_review:work}));return;}
 res.statusCode=409;res.end(JSON.stringify({error:{code:'task_review_output_unavailable'}}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{})});
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});page.on('pageerror',e=>faults.push(e.message));
 const origin='http://127.0.0.1:'+server.address().port;await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 await page.goto(origin);await page.getByRole('button',{name:'查看待验收文件'}).waitFor();assert.equal(reads.length,0);
 await page.getByRole('button',{name:'查看待验收文件'}).tap();const scope=page.getByRole('region',{name:'完整任务改动'});await scope.waitFor();
 assert.match(await scope.innerText(),/before.md → after.md/);assert.match(await scope.innerText(),/尚未发布到项目/);
 const result=scope.locator('details').filter({has:page.locator('summary',{hasText:'结果版本完整清单'})});await result.locator(':scope > summary').tap();assert.equal(await result.locator('li').count(),50);
 await result.getByRole('button',{name:'下一页'}).tap();assert.equal(await result.locator('li').count(),5);assert.match(await result.innerText(),/report-54.md/);
 await result.getByRole('button',{name:'上一页'}).tap();assert.equal(await result.locator('li').count(),50);
 await scope.getByText('本次选定方案原文',{exact:true}).tap();assert.equal(await page.evaluate(()=>window.injected),undefined);assert.match(await scope.innerText(),/<script>/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:join(output,'mobile.png')});
 await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:join(output,'desktop.png')});
 await page.evaluate(()=>window.switchReview());assert.equal(await page.getByRole('region',{name:'完整任务改动'}).count(),0);
 await page.getByRole('button',{name:'查看待验收文件'}).click();await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('region',{name:'完整任务改动'}).count(),0);
 assert.deepEqual(reads,[{method:'GET',path:'/workbench-api/v1/interactions/int-original/outputs'},{method:'GET',path:'/workbench-api/v1/interactions/int-next/outputs'}]);assert.deepEqual(faults,[]);
 console.log('PASS real React mobile/desktop review, 55-entry paging, escaped objective, no eager read or writes, stale-scope removal and revoked response');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
