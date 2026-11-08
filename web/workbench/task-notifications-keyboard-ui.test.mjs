import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {browserTestLaunchOptions} from '../../scripts/browser-test-launch.mjs';

test('notification settings keyboard entry, close-refresh and save preserve the matching focus target',{timeout:30000},async()=>{
 const base=fileURLToPath(new URL('../../.test-tmp/notification-focus/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-')),requests=[],faults=[];
 const previous={TEMP:process.env.TEMP,TMP:process.env.TMP};process.env.TEMP=root;process.env.TMP=root;
 let browser,server;
 try{
  const bundle=await build({stdin:{contents:"import '../workbench-entry.css';import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';import TaskNotificationsPanel from './TaskNotificationsPanel';import {request} from '../jot/client';function App(){const[ready,setReady]=useState(false);useEffect(()=>{request('/capabilities').then(()=>setReady(true));},[]);return ready?React.createElement(TaskNotificationsPanel,{taskId:'task-keyboard',bindingsEnabled:true,wecomBindingsEnabled:false,canEdit:true,onSaved:()=>{}}):null;}createRoot(document.getElementById('root')).render(React.createElement(App));",resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'tsx'},bundle:true,write:false,outfile:join(root,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
  let settings={task_id:'task-keyboard',version:0,channel_binding_ids:[],artifact_delivery_binding_ids:[],events:['completed'],delivery_policy:{min_interval_seconds:60,max_per_24_hours:20,quiet_hours:null}};
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost'),pathname=url.pathname;requests.push({method:req.method,path:pathname});
   const json=value=>{res.writeHead(200,{'content-type':'application/json','x-csrf-token':'synthetic-keyboard-token','x-workbench-draft-scope':'a'.repeat(64)});res.end(JSON.stringify(value));};
   if(pathname==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>');}
   const output=bundle.outputFiles.find(file=>file.path.replaceAll('\\','/').endsWith(pathname));
   if(output){res.writeHead(200,{'content-type':pathname.endsWith('.css')?'text/css':'text/javascript'});return res.end(output.text);}
   if(pathname==='/workbench-api/v1/capabilities')return json({});
   if(pathname==='/workbench-api/v1/channel-bindings')return json({items:[]});
   if(pathname==='/workbench-api/v1/persistent-tasks/task-keyboard/notifications'&&req.method==='GET')return json(settings);
   if(pathname==='/workbench-api/v1/persistent-tasks/task-keyboard/notifications'&&req.method==='PATCH'){const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));settings={...settings,...body,version:settings.version+1};return json(settings);}
   if(pathname==='/workbench-api/v1/persistent-tasks/task-keyboard/deliveries')return json({items:[],has_more:false});
   if(pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
   faults.push(req.method+' '+pathname);res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...await browserTestLaunchOptions(chromium),chromiumSandbox:true});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>faults.push(error.message));await page.goto(origin);
  const opener=page.getByRole('button',{name:'设置任务通知',exact:true});await opener.waitFor();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='设置任务通知')?.disabled);
  await opener.focus();await page.keyboard.press('Enter');
  const form=page.getByRole('form',{name:'设置任务通知',exact:true}),first=form.getByRole('checkbox',{name:'页面有变化',exact:true}),second=form.getByRole('checkbox',{name:'任务完成',exact:true});
  await first.waitFor();assert.equal(await first.evaluate(node=>node===document.activeElement),true,'opening by keyboard must move focus into the new form');
  await page.keyboard.press('Tab');assert.equal(await second.evaluate(node=>node===document.activeElement),true);await page.keyboard.press('Shift+Tab');await page.keyboard.press('Space');assert.equal(await first.isChecked(),true);
  const close=form.getByRole('button',{name:'关闭设置并刷新',exact:true});await close.focus();await page.keyboard.press('Enter');await opener.waitFor();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='设置任务通知')===document.activeElement);
  assert.equal(requests.filter(request=>request.path.endsWith('/notifications')&&request.method==='GET').length,2);assert.equal(requests.filter(request=>!['GET','HEAD'].includes(request.method)).length,0);
  await page.keyboard.press('Enter');await first.waitFor();assert.equal(await first.evaluate(node=>node===document.activeElement),true);assert.equal(await first.isChecked(),false);assert.equal(await second.isChecked(),true);
  await page.keyboard.press('Space');await form.getByRole('button',{name:'保存通知设置',exact:true}).focus();await page.keyboard.press('Enter');await page.getByText('任务通知设置已保存，原有结果和消耗保持不变。',{exact:true}).waitFor();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='设置任务通知')===document.activeElement);
  assert.equal(settings.version,1);assert.deepEqual(settings.events,['completed','changed']);assert.equal(requests.filter(request=>request.method==='PATCH').length,1);assert.deepEqual(faults,[]);
 }finally{
  await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
  for(const key of ['TEMP','TMP'])if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
 }
});
