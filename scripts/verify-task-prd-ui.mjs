// Dedicated real React/browser behavior checks with synthetic API responses.
// Bundles only this panel in memory; does not run the application/template build.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'..');
const compiled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Panel from './web/workbench/TaskPrdPanel.tsx';import {request} from './web/jot/client.ts';import './web/workbench/workbench.css';let task={task_id:'original-task',title:'Original task',version:7,status:'paused'};let ready=true;window.setTask=(patch)=>{task={...task,...patch};render()};window.setReady=(value)=>{ready=value;render()};const root=createRoot(document.getElementById('root'));function render(){root.render(<div onKeyDown={e=>{if(e.key==='Escape')document.getElementById('leave').click()}}><button id="leave" onClick={()=>document.getElementById('count').textContent=String(++window.leaves)}>离开任务</button><output id="count">0</output><Panel task={task} executionReady={ready} onBound={()=>{window.bound++}}/></div>)}window.leaves=0;window.bound=0;await request('/capabilities');render();`,resolveDir:root,sourcefile:'prd-browser.tsx',loader:'tsx'},bundle:true,write:false,outdir:resolve(root,'.test-tmp/prd-memory-build'),format:'esm',target:'es2022',logLevel:'silent'});
const js=compiled.outputFiles.find(f=>f.path.endsWith('.js')).text,css=compiled.outputFiles.find(f=>f.path.endsWith('.css'))?.text??'';
const source={kind:'logical_file',path:'docs/prd.md',version:2,sha256:'a'.repeat(64),name:'PRD.md',size:100};
const upload={kind:'upload',artifact_id:'original-upload',version:1,sha256:'b'.repeat(64),name:'brief.txt',size:40};
const content='# 原始需求\n<script>untrusted text</script>\n完整结尾 / END',objective='原任务目标\n\n'+content;
let mode='ready',binds=[],previews=[],reads=0,receipt=null,errors=[];
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost');const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','x-csrf-token':'synthetic-csrf','x-workbench-draft-scope':'d'.repeat(64)});res.end(JSON.stringify(value));};
 if(url.pathname==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/panel.css"><div class="wb-home" id="root"></div><script type="module" src="/panel.js"></script>');}
 if(url.pathname==='/panel.js'){res.setHeader('content-type','application/javascript');return res.end(js);}if(url.pathname==='/panel.css'){res.setHeader('content-type','text/css');return res.end(css);}
 if(url.pathname==='/workbench-api/v1/capabilities')return send({});
 if(url.pathname.endsWith('/prd/sources')){reads++;return send({task_id:'original-task',task_version:7,readiness:{ready:mode!=='blocked',reasons:mode==='blocked'?['PRD_EXECUTION_UNRESOLVED']:[]},sources:[source,upload],truncated:true,binding:receipt});}
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());assert.equal(req.headers['x-csrf-token'],'synthetic-csrf');
 if(url.pathname.endsWith('/prd/preview')){previews.push(body);return send({task_id:'original-task',task_version:7,role:{agent_id:'original-role',version:3,capability_epoch:4},source:body.source.kind==='upload'?upload:source,content,objective,preview_sha256:'c'.repeat(64),execution_authorized:false});}
 if(url.pathname.endsWith('/prd/bind')){binds.push({body,key:req.headers['idempotency-key']});if(mode==='conflict'){mode='ready';return send({error:{code:'PRD_SOURCE_CHANGED'}},409);}receipt={binding_id:'frozen-binding',task_id:'original-task',task_version:8,revision:1,source,content_sha256:source.sha256,objective_sha256:'e'.repeat(64),created_at:'2026-10-17T00:00:00Z',execution_authorized:false};return send(receipt);}
 throw Error('Unexpected API request: '+req.url);
 }catch(error){errors.push(error.message);res.writeHead(500);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser,diagnosticPage;
try{
 const browserEnv=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT','LOCALAPPDATA','APPDATA','USERPROFILE'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
 browser=await chromium.launch({headless:true,env:browserEnv,...(process.platform==='win32'?{channel:'msedge'}:{})});
 const page=await browser.newPage({viewport:{width:1100,height:900}});diagnosticPage=page;page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/prd/bind',async route=>{if(mode==='lose'){mode='ready';await route.fetch();await route.abort('failed');}else await route.continue();});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const panel=page.getByRole('region',{name:'PRD 绑定原任务'}),select=panel.getByLabel('PRD 来源');
 await select.selectOption('0');assert.match(await panel.innerText(),/目标/);assert.match(await panel.innerText(),/验收/);assert.match(await panel.innerText(),/依赖/);
 assert.equal(await panel.getByRole('button',{name:'确认绑定原暂停任务',exact:true}).count(),0);
 await panel.getByRole('button',{name:'只读预览'}).click();await panel.getByRole('checkbox').waitFor();
 assert.equal(await panel.getByLabel('PRD 原文').textContent(),content);assert.equal(await panel.getByLabel('完整任务目标').textContent(),objective);assert.equal(binds.length,0);
 const confirm=panel.getByRole('button',{name:'确认绑定原暂停任务',exact:true});assert.equal(await confirm.isDisabled(),true);
 await panel.getByRole('checkbox').check();await panel.getByRole('button',{name:'只读预览'}).click();await panel.getByRole('checkbox').waitFor();assert.equal(await panel.getByRole('checkbox').isChecked(),false,'a fresh preview requires renewed explicit confirmation');await panel.getByRole('checkbox').check();mode='lose';await confirm.click();const retry=panel.getByRole('button',{name:'重试原绑定请求'});await retry.waitFor();
 assert.equal(await select.isDisabled(),true);await page.getByRole('button',{name:'离开任务'}).click();await page.keyboard.press('Escape');assert.equal(await page.locator('#count').textContent(),'0');
 await page.getByRole('button',{name:'离开任务'}).focus();await page.keyboard.press('Tab');assert.equal(await retry.evaluate(node=>node===document.activeElement),true,'Tab can return keyboard focus to the original retry without activating outside navigation');
 assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true);
 page.once('dialog',dialog=>dialog.accept());await page.reload();await retry.waitFor();assert.equal(await select.isDisabled(),true);assert.equal(binds.length,1,'reload must never automatically resend an unknown command');
 await retry.click();await panel.getByText('已冻结绑定到原任务；任务保持暂停。').waitFor();assert.deepEqual(binds[0],binds[1]);assert.equal(await page.evaluate(()=>window.bound),1);
 await select.selectOption('1');await panel.getByRole('button',{name:'只读预览'}).click();await panel.getByRole('checkbox').check();mode='conflict';const previousReads=reads;await confirm.click();await page.waitForFunction(()=>document.querySelector('select')?.value==='');await page.waitForFunction(()=>!document.querySelector('select')?.disabled);assert.ok(reads>previousReads);assert.equal(await panel.getByLabel('完整任务目标').count(),0);
 assert.deepEqual(previews[2],{source:{kind:'upload',artifact_id:'original-upload',version:1,sha256:'b'.repeat(64)}});
 mode='blocked';await panel.getByRole('button',{name:'刷新来源与准备度'}).click();await panel.getByText('暂不可绑定：原任务仍有执行或未知执行结果，请先等待并核对回执。').waitFor();assert.equal(await select.isDisabled(),true);assert.doesNotMatch(await panel.innerText(),/PRD_EXECUTION_UNRESOLVED/);mode='ready';await panel.getByRole('button',{name:'刷新来源与准备度'}).click();await page.waitForFunction(()=>!document.querySelector('select')?.disabled);
 await page.evaluate(()=>window.setTask({status:'active'}));assert.equal(await panel.getByRole('button',{name:'只读预览'}).isDisabled(),true);
 await page.evaluate(()=>{window.setTask({status:'paused'});window.setReady(false)});assert.equal(await panel.getByRole('button',{name:'只读预览'}).isDisabled(),true);
 await page.evaluate(()=>window.setReady(true));await select.selectOption('0');await panel.getByRole('button',{name:'只读预览'}).click();await panel.getByRole('checkbox').waitFor();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.screenshot({path:join(tmpdir(),'thread2-prd-ui-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({realReact:true,syntheticApi:true,tests:['exact-selection','full-verbatim-preview','explicit-confirm','lost-receipt-same-key-body','same-tab-reload-recovery-no-auto-resend','pending-leave-and-unload-guard','conflict-refresh-reselect','server-readiness-paused-and-host-gate','mobile-no-overflow'],reads,previews:previews.length,binds:binds.length}));
}catch(error){console.error(JSON.stringify({errors,reads,binds,previews,ui:await diagnosticPage?.locator('body').innerText({timeout:1000}).catch(()=> 'unavailable')}));throw error;}finally{await browser?.close();await new Promise(r=>server.close(r));}
