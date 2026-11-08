// Actual TasksPanel caller path with synthetic refresh failure and keyboard recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {browserTestLaunchOptions} from '../../scripts/browser-test-launch.mjs';
import * as notificationFocus from './notification-ui.mjs';

test('in-flight run-history refresh stays armed for failure and retry completion',()=>{
 const tracker=notificationFocus.createNotificationRefreshFocusTracker();tracker.update(false);
 const saveResponseArrived=()=>tracker.begin();tracker.update(true);
 const pending=saveResponseArrived();
 assert.deepEqual(pending,{started:true});
 const failed=notificationFocus.advanceNotificationRefreshFocus(pending,{loading:false,error:'synthetic-occurrence-refresh-failed',hasData:true});
 assert.equal(failed.action,'retry');assert.equal(failed.pending,pending);
 const retrying=notificationFocus.advanceNotificationRefreshFocus(failed.pending,{loading:true,error:'',hasData:true});
 assert.equal(retrying.action,null);assert.equal(retrying.pending.started,true);
 const restored=notificationFocus.advanceNotificationRefreshFocus(retrying.pending,{loading:false,error:'',hasData:true});
 assert.equal(restored.action,'restore');assert.equal(restored.pending,null);
});

test('actual TasksPanel refresh failure focuses occurrence retry and success returns to matching notification opener',{timeout:30000},async()=>{
 const base=fileURLToPath(new URL('../../.test-tmp/notification-recovery-focus/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-')),requests=[],faults=[];
 const previous={TEMP:process.env.TEMP,TMP:process.env.TMP};process.env.TEMP=root;process.env.TMP=root;
 let browser,server,occurrenceReads=0;const settings={task_id:'task-actual-caller',version:0,channel_binding_ids:[],artifact_delivery_binding_ids:[],events:['completed'],delivery_policy:{min_interval_seconds:60,max_per_24_hours:20,quiet_hours:null}};
 const task={task_id:'task-actual-caller',title:'Keyboard recovery',agent_id:'agent',objective:'Test actual notification caller',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z',timezone:'Asia/Hong_Kong'},budget:{max_runs:1},status:'active',version:1,runs_used:0,next_due_at:null,created_at:'2026-10-23T00:00:00Z'};
 try{
  const bundle=await build({stdin:{contents:"import '../workbench-entry.css';import React from 'react';import {createRoot} from 'react-dom/client';import TasksPanel from './TasksPanel';import {MutationPending} from './useMutationReceipt';const caps={capabilities:{},workbench:{enabled:true,task_triggers:['once'],task_notifications:true,channel_bindings:false,email_bindings:false,agent_messages:false,task_readiness:false,model_budget:false,task_prd:false,task_reply_policy:false}};createRoot(document.getElementById('root')).render(React.createElement(MutationPending.Provider,{value:()=>{}},React.createElement(TasksPanel,{caps,agents:[],onConversation:()=>{}})));",resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'tsx'},bundle:true,write:false,outfile:join(root,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost'),pathname=url.pathname;requests.push({method:req.method,path:pathname});
   const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','x-csrf-token':'synthetic-actual-caller','x-workbench-draft-scope':'a'.repeat(64)});res.end(JSON.stringify(value));};
   if(pathname==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>');}
   const output=bundle.outputFiles.find(file=>file.path.replaceAll('\\','/').endsWith(pathname));
   if(output){res.writeHead(200,{'content-type':pathname.endsWith('.css')?'text/css':'text/javascript'});return res.end(output.text);}
   if(pathname==='/workbench-api/v1/persistent-tasks'&&req.method==='GET')return json({items:[task]});
   if(pathname==='/workbench-api/v1/persistent-tasks/task-actual-caller/occurrences'&&req.method==='GET'){
    occurrenceReads++;return occurrenceReads===2?json({error:{message:'synthetic-occurrence-refresh-failed'}},503):json({items:[]});
   }
   if(pathname==='/workbench-api/v1/persistent-tasks/task-actual-caller/notifications'&&req.method==='GET')return json(settings);
   if(pathname==='/workbench-api/v1/persistent-tasks/task-actual-caller/notifications'&&req.method==='PATCH'){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);Object.assign(settings,JSON.parse(Buffer.concat(chunks).toString('utf8')),{version:settings.version+1});return json(settings);
   }
   if(pathname==='/workbench-api/v1/persistent-tasks/task-actual-caller/deliveries')return json({items:[],has_more:false});
   if(pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
   faults.push(req.method+' '+pathname);res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...await browserTestLaunchOptions(chromium),chromiumSandbox:true});
  const context=await browser.newContext({viewport:{width:390,height:844}});await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>faults.push(error.message));await page.goto(origin);
  const executionOpener=page.getByRole('button',{name:'执行记录',exact:true});await executionOpener.click();
  const executionDialog=page.getByRole('dialog',{name:'Keyboard recovery执行记录',exact:true}),closeDialog=page.getByRole('button',{name:'关闭执行记录',exact:true});
  const opener=page.getByRole('button',{name:'设置任务通知',exact:true});await opener.waitFor();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='设置任务通知')?.disabled);
  await closeDialog.focus();await page.keyboard.press('Shift+Tab');assert.equal(await opener.evaluate(node=>node===document.activeElement),true,'Shift+Tab from the first dialog control must stay on its last control');
  await page.keyboard.press('Tab');assert.equal(await closeDialog.evaluate(node=>node===document.activeElement),true,'Tab from the last dialog control must stay on its first control');
  await opener.focus();await page.keyboard.press('Enter');const form=page.getByRole('form',{name:'设置任务通知',exact:true});
  await form.getByRole('checkbox',{name:'页面有变化',exact:true}).check();await form.getByRole('button',{name:'保存通知设置',exact:true}).click();
  const retry=page.getByRole('alert').filter({hasText:'synthetic-occurrence-refresh-failed'}).getByRole('button',{name:'重新读取',exact:true});await retry.waitFor();
  assert.equal(await opener.isDisabled(),true);assert.equal(await retry.evaluate(node=>node===document.activeElement),true,'actual caller failure must focus the occurrence retry action');
  assert.equal(occurrenceReads,2);assert.equal(requests.filter(request=>!['GET','HEAD'].includes(request.method)).length,1,'only the notification settings save may mutate');
  await page.keyboard.press('Enter');await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='设置任务通知')===document.activeElement);
  assert.equal(occurrenceReads,3);assert.equal(await page.getByRole('alert').filter({hasText:'synthetic-occurrence-refresh-failed'}).count(),0);
  await page.keyboard.press('Enter');assert.equal(await form.getByRole('checkbox',{name:'页面有变化',exact:true}).isChecked(),true);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='执行记录')===document.activeElement);
  assert.equal(await executionDialog.count(),0,'closing the dialog with Escape must return focus to its opener');
  assert.equal(requests.filter(request=>!['GET','HEAD'].includes(request.method)).length,1);assert.deepEqual(faults,[]);
 }finally{
  await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));
  const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
  for(const key of ['TEMP','TMP'])if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
 }
});
