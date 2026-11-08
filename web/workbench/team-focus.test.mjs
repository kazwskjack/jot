import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {browserTestLaunchOptions} from '../../scripts/browser-test-launch.mjs';

test('TeamsPanel restores form focus and manages delete dialog keyboard focus',{timeout:45000},async()=>{
 const base=process.env.TEMP??fileURLToPath(new URL('../../.test-tmp-team-focus/',import.meta.url));
 await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-')),faults=[],requests=[],requestFailures=[];
 const caps={workbench:{enabled:true,agent_roles:true,independent_teams:true,agent_messages:false,shared_workspace:false,execution_ready:false,memory_scopes:[],collaboration_modes:[],task_triggers:[],notification_channels:[],allowed_tools:[]},workspaces:[{workspace_id:'ws',title:'Workspace'}]};
 const agents=[{agent_id:'a1',name:'Agent One',workspace_id:'ws',project_id:'p1',conversation_id:'c1',status:'active',version:1,capability_epoch:1,allowed_tools:[],created_at:'now',updated_at:'now'}];
 const teams=[{team_id:'t1',name:'Alpha',workspace_id:'ws',project_id:'p1',member_ids:['a1'],status:'active',version:1,created_at:'now',updated_at:'now'}];
 let browser,holdDelete=false,releaseDelete;
 try{
  const bundle=await build({stdin:{contents:"import '../workbench-entry.css';import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Workbench from './Workbench';function App(){const[view,setView]=useState('teams');return <Workbench view={view} onOpen={setView} onConversation={()=>{}}/>}createRoot(document.getElementById('root')).render(<App/>);",resolveDir:fileURLToPath(new URL('./',import.meta.url)),loader:'tsx'},bundle:true,write:false,outfile:join(root,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
  browser=await chromium.launch({headless:true,...await browserTestLaunchOptions(chromium)});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),origin='http://127.0.0.1';
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();requests.push({method,path});
   if(url.origin!==origin)return route.abort();
   const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'x-csrf-token':'team-focus-test','x-workbench-draft-scope':'b'.repeat(64)},body:JSON.stringify(value)});
   if(path==='/')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>'});
   const output=bundle.outputFiles.find(file=>file.path.replaceAll('\\','/').endsWith(path));
   if(output)return route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/javascript',body:output.text});
   if(path==='/workbench-api/v1/capabilities'&&method==='GET')return json(caps);
   if(path==='/workbench-api/v1/agents'&&method==='GET')return json({items:agents});
   if(path==='/workbench-api/v1/teams'&&method==='GET')return json({items:teams.map(team=>({...team}))});
   if(path==='/workbench-api/v1/teams'&&method==='POST'){
    const body=JSON.parse(request.postData()||'{}'),team={team_id:'t'+(teams.length+1),name:body.name,workspace_id:body.workspace_id,project_id:'p1',member_ids:body.member_ids,status:'active',version:1,created_at:'now',updated_at:'now'};teams.push(team);return json(team,201);
   }
   if(path.startsWith('/workbench-api/v1/teams/')&&method==='PATCH'){
    const body=JSON.parse(request.postData()||'{}'),team=teams.find(item=>item.team_id===decodeURIComponent(path.split('/').at(-1)));
    if(!team)return json({error:{code:'NOT_FOUND',message:'NOT_FOUND'}},404);
    team.name=body.name??team.name;team.member_ids=body.member_ids??team.member_ids;team.version++;return json({...team});
   }
   if(path.startsWith('/workbench-api/v1/teams/')&&method==='DELETE'){
    if(holdDelete)await new Promise(resolve=>{releaseDelete=resolve;});
    const id=decodeURIComponent(path.split('/').at(-1)),index=teams.findIndex(item=>item.team_id===id);if(index>=0)teams.splice(index,1);
    return route.fulfill({status:204});
   }
   if(path==='/favicon.ico')return route.fulfill({status:204});
   faults.push(method+' '+path);return route.fulfill({status:404,body:'Not Found'});
  });
  context.on('requestfailed',request=>requestFailures.push({url:request.url(),failure:request.failure()?.errorText??''}));
  const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>faults.push(error.message));await page.goto(origin);
  const browserContext=await page.evaluate(()=>({isSecureContext,cryptoRandomUUID:typeof crypto.randomUUID}));console.log('R5_BROWSER_CONTEXT '+JSON.stringify(browserContext));
  assert.equal(browserContext.isSecureContext,true,'focus fixture must run in a secure context');assert.equal(browserContext.cryptoRandomUUID,'function','mutation receipt requires crypto.randomUUID');
  const create=page.getByRole('button',{name:'创建团队',exact:true});await create.waitFor();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent.includes('创建团队')&&!button.disabled));
  await page.getByRole('heading',{name:'Alpha',exact:true}).waitFor();

  await create.focus();await page.keyboard.press('Enter');
  let form=page.getByRole('form',{name:'创建团队',exact:true}),teamName=form.getByLabel('团队名称',{exact:true});
  await teamName.waitFor();assert.equal(await teamName.evaluate(node=>node===document.activeElement),true,'inline form starts at its name field');
  const closeForm=form.getByRole('button',{name:'关闭团队编辑',exact:true});await closeForm.click();
  assert.equal(await create.evaluate(node=>node===document.activeElement),true,'closing create form restores its opener');

  await create.focus();await page.keyboard.press('Enter');form=page.getByRole('form',{name:'创建团队',exact:true});teamName=form.getByLabel('团队名称',{exact:true});
  await teamName.fill('New Team');await form.getByLabel('Agent One',{exact:true}).check();
  const saveNew=form.getByRole('button',{name:'保存团队',exact:true});await saveNew.focus();await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('form')===null),true,'inline form does not trap Tab');
  await saveNew.click();try{await page.getByRole('heading',{name:'New Team',exact:true}).waitFor();}catch(error){console.error('R5_CREATE_FAILURE '+JSON.stringify({browserContext,requests,faults,requestFailures,alert:await page.getByRole('alert').textContent().catch(()=>null)}));throw error;}
  assert.equal(await create.evaluate(node=>node===document.activeElement),true,'successful create restores focus to its opener');

  const edit=page.getByRole('button',{name:'编辑成员',exact:true}).first();
  await edit.focus();await page.keyboard.press('Enter');form=page.getByRole('form',{name:'编辑团队',exact:true});teamName=form.getByLabel('团队名称',{exact:true});
  await teamName.waitFor();assert.equal(await teamName.evaluate(node=>node===document.activeElement),true);
  await form.getByRole('button',{name:'关闭团队编辑',exact:true}).click();
  assert.equal(await edit.evaluate(node=>node===document.activeElement),true,'closing edit form restores its opener');

  await edit.focus();await page.keyboard.press('Enter');form=page.getByRole('form',{name:'编辑团队',exact:true});teamName=form.getByLabel('团队名称',{exact:true});
  await teamName.fill('Unsaved draft');await page.setViewportSize({width:320,height:760});
  const deleteWhileEditing=page.getByRole('button',{name:'删除团队',exact:true}).first();await deleteWhileEditing.focus();await page.keyboard.press('Enter');
  const editDialog=page.getByRole('alertdialog',{name:'删除团队确认',exact:true}),editDialogCancel=editDialog.getByRole('button',{name:'取消',exact:true}),editDialogConfirm=editDialog.getByRole('button',{name:'确认删除',exact:true});
  await editDialog.waitFor();assert.equal(await editDialogCancel.evaluate(node=>node===document.activeElement),true,'delete confirmation takes focus from the still-open edit form');
  const editDialogBounds=await editDialog.boundingBox();assert.ok(editDialogBounds&&editDialogBounds.x>=0&&editDialogBounds.x+editDialogBounds.width<=320,'narrow-screen confirmation remains within the viewport');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'nested confirmation has no horizontal overflow');
  await page.keyboard.press('Shift+Tab');assert.equal(await editDialogConfirm.evaluate(node=>node===document.activeElement),true,'nested confirmation keeps reverse tab navigation inside the dialog');
  await page.keyboard.press('Escape');await editDialog.waitFor({state:'hidden'});
  assert.equal(await deleteWhileEditing.evaluate(node=>node===document.activeElement),true,'nested confirmation returns focus to its delete opener');
  assert.equal(await teamName.inputValue(),'Unsaved draft','canceling nested confirmation preserves the edit draft');
  await teamName.fill('Alpha Updated');await form.getByRole('button',{name:'保存团队',exact:true}).click();
  await page.getByRole('heading',{name:'Alpha Updated',exact:true}).waitFor();
  assert.equal(await edit.evaluate(node=>node===document.activeElement),true,'successful edit restores focus to its opener');

  const deleteTeam=page.getByRole('button',{name:'删除团队',exact:true}).first();await deleteTeam.focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('alertdialog',{name:'删除团队确认',exact:true}),cancel=dialog.getByRole('button',{name:'取消',exact:true}),confirm=dialog.getByRole('button',{name:'确认删除',exact:true});
  await dialog.waitFor();assert.equal(await dialog.isVisible(),true);assert.equal(await cancel.evaluate(node=>node===document.activeElement),true,'delete dialog starts with the safe cancel action');
  await confirm.focus();await page.keyboard.press('Tab');assert.equal(await cancel.evaluate(node=>node===document.activeElement),true,'Tab wraps inside the modal dialog');
  await page.keyboard.press('Shift+Tab');assert.equal(await confirm.evaluate(node=>node===document.activeElement),true,'Shift+Tab wraps inside the modal dialog');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal(await deleteTeam.evaluate(node=>node===document.activeElement),true,'Escape closes and restores focus to delete opener');

  holdDelete=true;await deleteTeam.focus();await page.keyboard.press('Enter');assert.equal(await cancel.evaluate(node=>node===document.activeElement),true);
  await confirm.click();await page.waitForFunction(()=>document.querySelector('[role="alertdialog"] .wb-danger')?.disabled===true);
  assert.equal(await dialog.evaluate(node=>node===document.activeElement),true,'pending deletion keeps focus on the dialog container');
  await page.keyboard.press('Tab');assert.equal(await dialog.evaluate(node=>node===document.activeElement),true,'Tab stays inside the dialog while both actions are disabled');
  await page.keyboard.press('Shift+Tab');assert.equal(await dialog.evaluate(node=>node===document.activeElement),true,'Shift+Tab stays inside the dialog while both actions are disabled');
  await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true,'Escape cannot dismiss while deletion is pending');
  holdDelete=false;releaseDelete?.();await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>{const active=document.activeElement,createButton=[...document.querySelectorAll('button')].find(button=>button.textContent.includes('创建团队')),heading=document.querySelector('.wb-toolbar h2');return active===createButton||active===heading;});
  assert.ok(await create.evaluate(node=>node===document.activeElement)||await page.getByRole('heading',{name:'角色团队',exact:true}).evaluate(node=>node===document.activeElement),'successful deletion focuses a surviving action or heading');
  assert.deepEqual(faults,[]);
  assert.equal(requests.filter(request=>request.method==='POST'&&request.path==='/workbench-api/v1/teams').length,1);
  assert.equal(requests.filter(request=>request.method==='PATCH'&&request.path==='/workbench-api/v1/teams/t1').length,1);
  assert.equal(requests.filter(request=>request.method==='DELETE'&&request.path==='/workbench-api/v1/teams/t1').length,1);
 }finally{
  releaseDelete?.();await browser?.close();const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});

test('TeamsPanel touch activation retains dialog focus through portrait and landscape rotation',{timeout:45000},async()=>{
 const base=process.env.TEMP??fileURLToPath(new URL('../../.test-tmp-team-focus/',import.meta.url));
 await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'touch-rotation-case-')),faults=[];
 const caps={workbench:{enabled:true,agent_roles:true,independent_teams:true,agent_messages:false,shared_workspace:false,execution_ready:false,memory_scopes:[],collaboration_modes:[],task_triggers:[],notification_channels:[],allowed_tools:[]},workspaces:[{workspace_id:'ws',title:'Workspace'}]};
 const agents=[{agent_id:'a1',name:'Agent One',workspace_id:'ws',project_id:'p1',conversation_id:'c1',status:'active',version:1,capability_epoch:1,allowed_tools:[],created_at:'now',updated_at:'now'}];
 const teams=[{team_id:'t1',name:'Alpha',workspace_id:'ws',project_id:'p1',member_ids:['a1'],status:'active',version:1,created_at:'now',updated_at:'now'}];
 let browser;
 try{
  const bundle=await build({stdin:{contents:"import '../workbench-entry.css';import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Workbench from './Workbench';function App(){const[view,setView]=useState('teams');return <Workbench view={view} onOpen={setView} onConversation={()=>{}}/>}createRoot(document.getElementById('root')).render(<App/>);",resolveDir:fileURLToPath(new URL('./',import.meta.url)),loader:'tsx'},bundle:true,write:false,outfile:join(root,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
  browser=await chromium.launch({headless:true,...await browserTestLaunchOptions(chromium)});
  const context=await browser.newContext({viewport:{width:320,height:760},isMobile:true,hasTouch:true}),origin='http://127.0.0.1';
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
   if(url.origin!==origin)return route.abort();
   const json=value=>route.fulfill({status:200,contentType:'application/json',headers:{'x-csrf-token':'team-touch-test','x-workbench-draft-scope':'d'.repeat(64)},body:JSON.stringify(value)});
   if(path==='/')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>'});
   const output=bundle.outputFiles.find(file=>file.path.replaceAll('\\','/').endsWith(path));
   if(output)return route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/javascript',body:output.text});
   if(path==='/workbench-api/v1/capabilities'&&method==='GET')return json(caps);
   if(path==='/workbench-api/v1/agents'&&method==='GET')return json({items:agents});
   if(path==='/workbench-api/v1/teams'&&method==='GET')return json({items:teams});
   if(path==='/favicon.ico')return route.fulfill({status:204});
   faults.push(method+' '+path);return route.fulfill({status:404,body:'Not Found'});
  });
  const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>faults.push(error.message));await page.goto(origin);
  await page.getByRole('heading',{name:'Alpha',exact:true}).waitFor();
  const deleteTeam=page.getByRole('button',{name:'删除团队',exact:true}).first(),tap=async locator=>{const box=await locator.boundingBox();assert.ok(box);await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);};
  await tap(deleteTeam);
  const dialog=page.getByRole('alertdialog',{name:'删除团队确认',exact:true}),cancel=dialog.getByRole('button',{name:'取消',exact:true});
  await dialog.waitFor();assert.equal(await cancel.evaluate(node=>node===document.activeElement),true,'touch opening moves focus to the safe dialog action');
  await page.setViewportSize({width:760,height:320});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));
  const box=await dialog.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=760&&box.y>=0&&box.y+box.height<=320,'rotated alertdialog remains within the landscape viewport');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'landscape confirmation has no horizontal overflow');
  assert.equal(await cancel.evaluate(node=>node===document.activeElement),true,'rotation retains dialog focus');
  await tap(cancel);await dialog.waitFor({state:'hidden'});
  assert.equal(await deleteTeam.evaluate(node=>node===document.activeElement),true,'touch cancellation returns focus to the opener after rotation');
  assert.deepEqual(faults,[]);
 }finally{
  await browser?.close();const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});

test('TeamsPanel edit form blocks Enter while composition state is active',{timeout:45000},async()=>{
 const base=process.env.TEMP??fileURLToPath(new URL('../../.test-tmp-team-focus/',import.meta.url));
 await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'ime-edit-case-')),faults=[];
 const caps={workbench:{enabled:true,agent_roles:true,independent_teams:true,agent_messages:false,shared_workspace:false,execution_ready:false,memory_scopes:[],collaboration_modes:[],task_triggers:[],notification_channels:[],allowed_tools:[]},workspaces:[{workspace_id:'ws',title:'Workspace'}]};
 const agents=[{agent_id:'a1',name:'Agent One',workspace_id:'ws',project_id:'p1',conversation_id:'c1',status:'active',version:1,capability_epoch:1,allowed_tools:[],created_at:'now',updated_at:'now'}];
 const teams=[{team_id:'t1',name:'Alpha',workspace_id:'ws',project_id:'p1',member_ids:['a1'],status:'active',version:1,created_at:'now',updated_at:'now'}];let browser;
 try{
  const app=`import '../workbench-entry.css';import React from 'react';import{createRoot}from'react-dom/client';import TeamsPanel from './TeamsPanel';const caps=${JSON.stringify(caps)},agents=${JSON.stringify(agents)};createRoot(document.getElementById('root')).render(<TeamsPanel caps={caps} agents={agents} onConversation={()=>{}}/>);`;
  const bundle=await build({stdin:{contents:app,resolveDir:fileURLToPath(new URL('./',import.meta.url)),loader:'tsx'},bundle:true,write:false,outfile:join(root,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
  browser=await chromium.launch({headless:true,...await browserTestLaunchOptions(chromium)});
  const context=await browser.newContext({viewport:{width:320,height:760},isMobile:true,hasTouch:true});
  const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>faults.push(error.message));await page.setContent('<div id="root"></div>');
  await page.evaluate(initialTeams=>{
   window.__r5Requests=[];window.__r5SubmitCount=0;document.addEventListener('submit',()=>window.__r5SubmitCount++,true);
   window.fetch=async(url,init={})=>{const path=String(url).split('?')[0],method=String(init.method??'GET').toUpperCase();window.__r5Requests.push({path,method});
    let body,status=200;if(path==='/workbench-api/v1/teams'&&method==='GET')body={items:initialTeams};
    else if(path.startsWith('/workbench-api/v1/teams/')&&method==='PATCH')body={...initialTeams[0],name:JSON.parse(init.body??'{}').name,version:initialTeams[0].version+1};
    else{status=404;body={error:{code:'NOT_FOUND',message:'NOT_FOUND'}};}
    return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','x-csrf-token':'team-ime-test','x-workbench-draft-scope':'f'.repeat(64)}});
   };
  },teams);
  const script=bundle.outputFiles.find(file=>file.path.replaceAll('\\','/').endsWith('/bundle.js'));assert.ok(script,'browser test bundle was emitted');await page.addScriptTag({content:script.text});
  await page.getByRole('heading',{name:'Alpha',exact:true}).waitFor();
  const edit=page.getByRole('button',{name:'编辑成员',exact:true}).first();await edit.focus();await page.keyboard.press('Enter');
  const form=page.getByRole('form',{name:'编辑团队',exact:true}),input=form.getByLabel('团队名称',{exact:true});await input.waitFor();
  await page.evaluate(()=>{window.__r5ImeEvents=[];document.addEventListener('keydown',event=>{if(event.key==='Enter')window.__r5ImeEvents.push({isComposing:event.isComposing,keyCode:event.keyCode});},true);});
  await input.fill('Alpha Research');
  await input.evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
  await input.press('Enter');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.waitForTimeout(50);
  const enter=await page.evaluate(()=>window.__r5ImeEvents.at(-1));
  assert.equal(enter?.isComposing,false,'fixture uses an Enter key whose native composition flag is false');
  assert.equal(enter?.keyCode,13,'fixture uses ordinary Enter keycode while composition state is active');
  assert.equal(await page.evaluate(()=>window.__r5SubmitCount),0,'active composition must not submit the team edit form');
  assert.equal((await page.evaluate(()=>window.__r5Requests.filter(request=>request.method==='PATCH').length)),0,'active composition must not send a team edit request');
  assert.equal(await input.inputValue(),'Alpha Research','composition confirmation preserves the team name draft');
  assert.deepEqual(faults,[]);
 }finally{
  await browser?.close();const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});
