import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {browserTestLaunchOptions} from '../../scripts/browser-test-launch.mjs';

const integrationRoot=process.env.M19_U5_R3_INTEGRATION_ROOT;
if(!integrationRoot)throw new Error('M19_U5_R3_INTEGRATION_ROOT must point to the read-only worker 13 R3 integration checkout');
const moduleAt=path=>import(pathToFileURL(join(integrationRoot,path)).href);
const {completionFixture}=await moduleAt('packages/gateway/test/workbench/task-completion-fixture.mjs');
const {OwnerChannelBindings}=await moduleAt('packages/gateway/src/channels/owner-bindings.ts');

test('real notification UI saves, reloads and late-owner rejects WeCom file consent via Gateway and SQLite',{timeout:90000},async t=>{
 let binding,uiTask;
 const f=await completionFixture(t,{beforeRun:async fixture=>{
  const channels=new OwnerChannelBindings(fixture.db,{enabled:['wecom']});const challenge=channels.create('alice','wecom');channels.acceptProof('wecom','synthetic-ui-recipient',challenge.code);
  binding=channels.list('alice').items.find(item=>item.channel==='wecom'&&item.status==='verified');
  uiTask=fixture.persistentTasks.create('alice',{title:'UI acceptance task',agent_id:fixture.a.agent_id,objective:'Save owner-approved output delivery',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 }});
 let browser;const root=resolve('.test-tmp/m19-u5-parent-integration'),uiRoot=join(root,'ui');await import('node:fs/promises').then(fs=>fs.mkdir(uiRoot,{recursive:true}));
 try{
  const bundle=await build({stdin:{contents:`
   import '../workbench-entry.css';
   import React,{useEffect,useState} from 'react';
   import {createRoot} from 'react-dom/client';
   import TaskNotificationsPanel from './TaskNotificationsPanel.tsx';
   import {request} from '../jot/client';
   import {workbenchApi} from './client';
   function App(){
    const [ready,setReady]=useState(false),[identityRevision,setIdentityRevision]=useState(0);
    useEffect(()=>{request('/capabilities').then(()=>setReady(true)).catch(error=>{document.body.dataset.bootstrapError=String(error);});},[identityRevision]);
    window.__refreshOwner=async()=>{await request('/capabilities');setIdentityRevision(value=>value+1);};
    window.__lateOwnerSave=async(body,key)=>{try{await workbenchApi.saveTaskNotifications(${JSON.stringify(uiTask.task_id)},body,key);return {status:200};}catch(error){return {status:error.status??0,message:error.message};}};
    return ready?React.createElement(React.Fragment,null,
     React.createElement('button',{onClick:()=>window.__refreshOwner()},'刷新所有者范围'),
     React.createElement(TaskNotificationsPanel,{taskId:${JSON.stringify(uiTask.task_id)},bindingsEnabled:true,wecomBindingsEnabled:true,canEdit:true,onSaved:()=>{}})
    ):React.createElement('p',null,'加载合成会话');
   }
   createRoot(document.getElementById('root')).render(React.createElement(App));
  `,resolveDir:resolve('../..','web/workbench'),loader:'tsx'},bundle:true,write:false,outfile:join(uiRoot,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'}).catch(error=>({error}));
  assert.ok(!bundle.error,`parent UI bundle failed: ${bundle.error?.errors?.map(item=>item.text).join('; ')??bundle.error?.message}`);
  browser=await chromium.launch({headless:true,...await browserTestLaunchOptions(chromium),chromiumSandbox:true});const page=await browser.newPage({viewport:{width:430,height:900},isMobile:true,hasTouch:true});page.setDefaultTimeout(15000);
  let owner='alice',loseFirstPatch=true;const patches=[];const origin='https://artifact-delivery-parent.test';
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
   if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>'});
   if(url.pathname.startsWith('/workbench-api/v1/')){
    const request=route.request(),incoming=request.headers(),path=url.pathname.replace('/workbench-api','')+url.search;
    const headers={'x-user-id':owner,origin:'https://fixture.invalid'};for(const key of ['x-csrf-token','x-jot-actor','idempotency-key','content-type'])if(incoming[key])headers[key]=incoming[key];
    const response=await f.app.inject({method:request.method(),url:path,headers,...(request.postData()?{payload:request.postData()}: {})});
    if(path===`/v1/persistent-tasks/${uiTask.task_id}/notifications`&&request.method()==='PATCH'){
     patches.push({body:JSON.parse(request.postData()??'{}'),key:incoming['idempotency-key'],status:response.statusCode,responseBody:response.body});
     if(loseFirstPatch){loseFirstPatch=false;return route.fulfill({status:504,contentType:'application/json',body:'{"error":{"code":"synthetic-response-lost"}}'});}
    }
    const responseHeaders={};for(const key of ['content-type','x-csrf-token','x-workbench-draft-scope'])if(response.headers[key])responseHeaders[key]=response.headers[key];
    return route.fulfill({status:response.statusCode,headers:responseHeaders,body:response.body});
   }
   const file=bundle.outputFiles.find(item=>item.path.endsWith(url.pathname.slice(1)));return file?route.fulfill({status:200,contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:file.text}):route.fulfill({status:404,body:'not found'});
  });
  await page.goto(origin);const settingsButton=page.getByRole('button',{name:'设置任务通知',exact:true});await settingsButton.waitFor();await settingsButton.click();
  const channel=page.getByRole('checkbox',{name:new RegExp(`微信(?:企业)?渠道 .*${binding.channel_binding_id.slice(-6)}`)});await channel.waitFor();await channel.check();
  const file=page.getByRole('checkbox',{name:/发送本任务已审核的文件输出到/});await file.waitFor();assert.equal(await file.isDisabled(),false);await file.check();
  await page.getByRole('button',{name:'保存通知设置',exact:true}).click();await page.getByText('请求结果待确认，重试沿用原设置。',{exact:true}).waitFor();assert.equal(await file.isDisabled(),true);
  await page.getByRole('button',{name:'重试原设置',exact:true}).click();const successNotice=page.getByText('任务通知设置已保存，原有结果和消耗保持不变。',{exact:true});await Promise.race([successNotice.waitFor({timeout:5000}),page.getByRole('alert').waitFor({timeout:5000})]).catch(()=>{});if(!await successNotice.isVisible().catch(()=>false))throw new Error(`retry failed: alert=${await page.getByRole('alert').textContent().catch(()=>'<none>')}; patches=${JSON.stringify(patches)}`);
  assert.equal(patches.length,2);assert.deepEqual(patches[1].body,patches[0].body);assert.equal(patches[1].key,patches[0].key);assert.deepEqual(patches[0].body,{expected_version:0,channel_binding_ids:[binding.channel_binding_id],delivery_policy:{min_interval_seconds:60,max_per_24_hours:20,quiet_hours:null},events:['completed'],artifact_delivery_binding_ids:[binding.channel_binding_id]});
  const stored=f.db.prepare('SELECT version,bindings_json FROM wb_task_notification_settings WHERE task_id=? AND owner_id=?').get(uiTask.task_id,'alice');assert.equal(stored.version,1);assert.deepEqual(JSON.parse(stored.bindings_json),[{channel_binding_id:binding.channel_binding_id,version:binding.version,artifact_delivery:true}]);
  await page.getByRole('button',{name:'设置任务通知',exact:true}).click();const reloaded=page.getByRole('checkbox',{name:/发送本任务已审核的文件输出到/});await reloaded.waitFor();assert.equal(await reloaded.isChecked(),true);
  // A later binding inventory change cannot reinterpret an already frozen save.
  loseFirstPatch=true;await page.getByRole('button',{name:'保存通知设置',exact:true}).click();await page.getByText('请求结果待确认，重试沿用原设置。',{exact:true}).waitFor();
  new OwnerChannelBindings(f.db).revoke('alice',binding.channel_binding_id,binding.version);
  await page.getByRole('button',{name:'生成微信绑定码',exact:true}).click();await page.getByText(new RegExp(`渠道 · ${binding.channel_binding_id.slice(-6)} · 已撤销`)).waitFor();
  await page.getByRole('button',{name:'重试原设置',exact:true}).click();await settingsButton.waitFor({state:'visible',timeout:5000});
  assert.equal(patches.length,4);assert.deepEqual(patches[3].body,patches[2].body);assert.equal(patches[3].key,patches[2].key);
  const afterRetry=f.db.prepare('SELECT version,bindings_json FROM wb_task_notification_settings WHERE task_id=? AND owner_id=?').get(uiTask.task_id,'alice');assert.equal(afterRetry.version,2);
  owner='bob';await page.getByRole('button',{name:'刷新所有者范围',exact:true}).click();await page.getByText('任务不存在或不可访问',{exact:false}).waitFor({timeout:3000}).catch(()=>{});
  await page.waitForFunction(()=>!document.querySelector('input[type="checkbox"]:checked'));
  await page.waitForFunction(()=>!document.querySelector('[aria-label="微信绑定验证"]'));
  const late=await page.evaluate(async({body,key})=>window.__lateOwnerSave(body,key),{body:patches[2].body,key:patches[2].key});assert.equal(late.status,404);
  const stillAlice=f.db.prepare('SELECT version,bindings_json FROM wb_task_notification_settings WHERE task_id=? AND owner_id=?').get(uiTask.task_id,'alice');assert.equal(stillAlice.version,2);assert.equal(stillAlice.bindings_json,afterRetry.bindings_json);
 }finally{await browser?.close();const child=relative(root,uiRoot);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await import('node:fs/promises').then(fs=>fs.rm(uiRoot,{recursive:true,force:true,maxRetries:5,retryDelay:20}));}
});
