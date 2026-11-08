import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {browserTestLaunchOptions} from '../../scripts/browser-test-launch.mjs';

test('real ChannelBinding DTO keeps file consent WeCom-only and clears stale selections',{timeout:60000},async()=>{
 const rootBase=resolve('.test-tmp/task-artifact-delivery-ui');await import('node:fs/promises').then(fs=>fs.mkdir(rootBase,{recursive:true}));
 const root=await mkdtemp(join(rootBase,'case-'));let browser;
 try{
  const bundle=await build({stdin:{contents:`
   import '../workbench-entry.css';
   import React,{useState} from 'react';
   import {createRoot} from 'react-dom/client';
   import TaskArtifactDeliveryOptions from './TaskArtifactDeliveryOptions.tsx';
   function App(){
    const [selected,setSelected]=useState([{channel_binding_id:'wecom-01',binding_version:5}]);
    const [bindingVersion,setBindingVersion]=useState(5),[scopeEpoch,setScopeEpoch]=useState('owner-a:task-a'),[settingsVersion,setSettingsVersion]=useState(9),[completed,setCompleted]=useState(true),[frozen,setFrozen]=useState(false);
    const targets=[
     {channel_binding_id:'wecom-01',channel:'wecom',status:'verified',version:bindingVersion},
     {channel_binding_id:'email-02',channel:'email',status:'verified',version:3},
     {channel_binding_id:'push-03',channel:'webpush',status:'verified',version:2},
     {channel_binding_id:'pending-04',channel:'wecom',status:'pending',version:1},
    ];
    const notificationDraft={expected_version:settingsVersion,channel_binding_ids:['wecom-01','email-02','push-03','pending-04'],events:completed?['completed']:['failed']};
    const parent={settingsVersion,key:'same-request-key',body:{expected_version:9,channel_binding_ids:['wecom-01'],events:['completed'],artifact_delivery_binding_ids:['wecom-01']}};
    return React.createElement('main',null,
     React.createElement('button',{onClick:()=>setBindingVersion(value=>value+1)},'更换绑定版本'),
     React.createElement('button',{onClick:()=>setScopeEpoch(value=>value==='owner-a:task-a'?'owner-b:task-a':'owner-a:task-a')},'切换 owner'),
     React.createElement('button',{onClick:()=>setScopeEpoch(value=>value.endsWith(':next')?value.slice(0,-5):value+':next')},'切换任务'),
     React.createElement('button',{onClick:()=>setSettingsVersion(value=>value+1)},'刷新设置版本'),
     React.createElement('button',{onClick:()=>setCompleted(value=>!value)},'切换完成提醒'),
     React.createElement('button',{onClick:()=>setFrozen(value=>!value)},'切换未知回执'),
     React.createElement(TaskArtifactDeliveryOptions,{targets,notificationDraft,selected,scopeEpoch,selectionFrozen:frozen,onChange:setSelected}),
     React.createElement('output',{'aria-label':'选择状态'},JSON.stringify(selected)),
     React.createElement('output',{'aria-label':'父级冻结请求'},JSON.stringify(parent))
    );
   }
   createRoot(document.getElementById('root')).render(React.createElement(App));
  `,resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'tsx'},bundle:true,write:false,outfile:join(root,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'}).catch(error=>({error}));
  assert.ok(!bundle.error,`component bundle failed: ${bundle.error?.errors?.map(item=>item.text).join('; ')??bundle.error?.message}`);
  browser=await chromium.launch({headless:true,...await browserTestLaunchOptions(chromium),chromiumSandbox:true});const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(10000);
  const origin='https://artifact-binding-ui.test';await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>'});const file=bundle.outputFiles.find(item=>item.path.endsWith(url.pathname.slice(1)));return file?route.fulfill({status:200,contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:file.text}):route.fulfill({status:404,body:'not found'});});
  await page.goto(origin);const group=page.getByRole('group',{name:'本任务文件输出',exact:true}),wecom=group.getByRole('checkbox',{name:/com-01/}),email=group.getByRole('checkbox',{name:/il-02/}),push=group.getByRole('checkbox',{name:/sh-03/}),pending=group.getByRole('checkbox',{name:/ng-04/});
  const selection=page.getByLabel('选择状态',{exact:true}),waitSelection=expected=>page.waitForFunction(value=>document.querySelector('output[aria-label="选择状态"]')?.textContent===value,expected);
  await group.waitFor();assert.equal(await wecom.isChecked(),true);assert.equal(await email.isDisabled(),true);assert.equal(await push.isDisabled(),true);assert.equal(await pending.isDisabled(),true);
  await group.getByText('此渠道暂不支持文件输出。',{exact:true}).first().waitFor();
  await page.getByRole('button',{name:'切换未知回执'}).click();assert.equal(await wecom.isDisabled(),true);assert.equal(await selection.textContent(),'[{"channel_binding_id":"wecom-01","binding_version":5}]');assert.equal(await page.getByLabel('父级冻结请求',{exact:true}).textContent(),'{"settingsVersion":9,"key":"same-request-key","body":{"expected_version":9,"channel_binding_ids":["wecom-01"],"events":["completed"],"artifact_delivery_binding_ids":["wecom-01"]}}');
  await page.getByRole('button',{name:'切换未知回执'}).click();await page.getByRole('button',{name:'更换绑定版本'}).click();await waitSelection('[]');assert.equal(await wecom.isChecked(),false);await wecom.tap();await waitSelection('[{"channel_binding_id":"wecom-01","binding_version":6}]');
  await page.getByRole('button',{name:'刷新设置版本'}).click();await waitSelection('[]');await wecom.tap();await waitSelection('[{"channel_binding_id":"wecom-01","binding_version":6}]');
  await page.getByRole('button',{name:'切换 owner'}).click();await waitSelection('[]');await wecom.tap();await waitSelection('[{"channel_binding_id":"wecom-01","binding_version":6}]');await page.getByRole('button',{name:'切换任务'}).click();await waitSelection('[]');await page.getByRole('button',{name:'切换完成提醒'}).click();await waitSelection('[]');assert.equal(await wecom.isDisabled(),true);
 }finally{await browser?.close();assert.ok(resolve(root).startsWith(resolve(rootBase)+sep));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
