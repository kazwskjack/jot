import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';

test('ProjectsPanel restores keyboard focus after create, rename, and conflict closure',{timeout:45000},async()=>{
 const base=process.env.TEMP??fileURLToPath(new URL('../../.test-tmp-project-focus/',import.meta.url));
 await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-')),projects=[],requests=[],createAttempts=[],faults=[],requestFailures=[];
 let browser,next=0,loseCreateResponse=true;
 try{
  const bundle=await build({stdin:{contents:"import '../workbench-entry.css';import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Workbench from './Workbench';function App(){const[view,setView]=useState('projects');return <Workbench view={view} onOpen={setView} onConversation={()=>{}}/>}createRoot(document.getElementById('root')).render(<App/>);",resolveDir:fileURLToPath(new URL('./',import.meta.url)),loader:'tsx'},bundle:true,write:false,outfile:join(root,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
  const origin='http://127.0.0.1';
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();requests.push({method,path});
   if(url.origin!==origin)return route.abort();
   const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'x-csrf-token':'focus-test','x-workbench-draft-scope':'a'.repeat(64)},body:JSON.stringify(value)});
   if(path==='/')return route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>'});
   const output=bundle.outputFiles.find(file=>file.path.replaceAll('\\','/').endsWith(path));
   if(output)return route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/javascript',body:output.text});
   if(path==='/workbench-api/v1/capabilities'&&method==='GET')return json({workbench:{agent_roles:false}});
   if(path==='/workbench-api/v1/projects'&&method==='GET')return json({items:projects.map(item=>({...item})),has_more:false});
   if(path==='/workbench-api/v1/projects'&&method==='POST'){
    const body=JSON.parse(request.postData()||'{}');createAttempts.push({key:request.headers()['idempotency-key'],body});
    if(!projects.length)projects.push({project_id:'p'+(++next),title:body.title,version:1,is_default:false,archived:false,active_conversation_count:0,archived_conversation_count:0});
    if(loseCreateResponse){loseCreateResponse=false;return route.abort('failed');}
    return json(projects[0],201);
   }
   if(path.startsWith('/workbench-api/v1/projects/')&&method==='PATCH'){
    const body=JSON.parse(request.postData()||'{}'),id=decodeURIComponent(path.split('/').at(-1)),project=projects.find(item=>item.project_id===id);
    if(!project)return json({error:{code:'NOT_FOUND',message:'NOT_FOUND'}},404);
    if(body.expected_version!==project.version)return json({error:{code:'VERSION_CONFLICT',message:'VERSION_CONFLICT'}},409);
    project.title=body.title;project.version++;return json({...project});
   }
   if(path==='/favicon.ico')return route.fulfill({status:204});
   faults.push(method+' '+path);return route.fulfill({status:404,body:'Not Found'});
  });
  context.on('requestfailed',request=>requestFailures.push({url:request.url(),failure:request.failure()?.errorText??''}));
  const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>faults.push(error.message));await page.goto(origin);
  const browserContext=await page.evaluate(()=>({isSecureContext,cryptoRandomUUID:typeof crypto.randomUUID}));console.log('R5_BROWSER_CONTEXT '+JSON.stringify(browserContext));
  assert.equal(browserContext.isSecureContext,true,'focus fixture must run in a secure context');assert.equal(browserContext.cryptoRandomUUID,'function','mutation receipt requires crypto.randomUUID');
  const create=page.getByRole('button',{name:'创建项目',exact:true});
  await create.focus();await page.keyboard.press('Enter');await page.getByLabel('新项目名称',{exact:true}).waitFor();
  await page.getByRole('button',{name:'取消',exact:true}).focus();await page.keyboard.press('Enter');
  assert.equal(await create.evaluate(node=>node===document.activeElement),true,'create cancel returns focus to opener');

  await create.focus();await page.keyboard.press('Enter');const newTitle=page.getByLabel('新项目名称',{exact:true});await newTitle.fill('Research');await newTitle.press('Enter');
  const retry=page.getByRole('button',{name:'重试原请求',exact:true});await retry.waitFor();
  assert.equal(await retry.evaluate(node=>node===document.activeElement),true,'uncertain create failure focuses its keyboard recovery action');
  await page.keyboard.press('Enter');
  try{await page.getByText('Research',{exact:true}).waitFor();}catch(error){console.error('R5_CREATE_FAILURE '+JSON.stringify({browserContext,requests,faults,requestFailures,alert:await page.getByRole('alert').textContent().catch(()=>null)}));throw error;}
  assert.equal(await create.evaluate(node=>node===document.activeElement),true,'create success returns focus to create action');
  assert.equal(createAttempts.length,2,'the keyboard recovery retries the uncertain request');assert.deepEqual(createAttempts[1],createAttempts[0],'the retry reuses the original idempotency receipt');assert.equal(projects.length,1,'a lost response does not create a duplicate project');

  const rename=page.getByRole('button',{name:'重命名 Research',exact:true});
  await rename.focus();await page.keyboard.press('Enter');await page.getByLabel('项目名称',{exact:true}).waitFor();
  await page.getByRole('button',{name:'取消',exact:true}).focus();await page.keyboard.press('Enter');
  assert.equal(await rename.evaluate(node=>node===document.activeElement),true,'rename cancel returns focus to row action');

  await rename.focus();await page.keyboard.press('Enter');const title=page.getByLabel('项目名称',{exact:true});await title.fill('Ideas');await title.press('Enter');
  await page.getByText('Ideas',{exact:true}).waitFor();const renameIdeas=page.getByRole('button',{name:'重命名 Ideas',exact:true});
  assert.equal(await renameIdeas.evaluate(node=>node===document.activeElement),true,'rename success returns focus to updated row action');

  const other=await context.newPage();other.setDefaultTimeout(5000);other.on('pageerror',error=>faults.push(error.message));await other.goto(origin);
  await other.getByRole('button',{name:'重命名 Ideas',exact:true}).click();await other.getByLabel('项目名称',{exact:true}).fill('Remote Ideas');await other.getByRole('button',{name:'保存名称',exact:true}).click();await other.getByText('Remote Ideas',{exact:true}).waitFor();
  await renameIdeas.focus();await page.keyboard.press('Enter');await page.getByLabel('项目名称',{exact:true}).fill('Notes');await page.getByLabel('项目名称',{exact:true}).press('Enter');
  const recovery=page.getByRole('button',{name:'继续重命名 Remote Ideas',exact:true});await recovery.waitFor();
  assert.equal(await recovery.evaluate(node=>node===document.activeElement),true,'version conflict moves focus to recovery action');
  assert.deepEqual(faults,[]);
 }finally{
  await browser?.close();
  const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});

test('ProjectsPanel preserves form focus through touch and viewport rotation',{timeout:45000},async()=>{
 const base=process.env.TEMP??fileURLToPath(new URL('../../.test-tmp-project-focus/',import.meta.url));
 await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'ime-case-')),projects=[],faults=[];
 let browser,createRequests=0;
 try{
  const bundle=await build({stdin:{contents:"import '../workbench-entry.css';import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Workbench from './Workbench';function App(){const[view,setView]=useState('projects');return <Workbench view={view} onOpen={setView} onConversation={()=>{}}/>}createRoot(document.getElementById('root')).render(<App/>);",resolveDir:fileURLToPath(new URL('./',import.meta.url)),loader:'tsx'},bundle:true,write:false,outfile:join(root,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({viewport:{width:320,height:760},isMobile:true,hasTouch:true}),origin='http://127.0.0.1';
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
   if(url.origin!==origin)return route.abort();
   const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'x-csrf-token':'project-ime-test','x-workbench-draft-scope':'c'.repeat(64)},body:JSON.stringify(value)});
   if(path==='/')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>'});
   const output=bundle.outputFiles.find(file=>file.path.replaceAll('\\','/').endsWith(path));
   if(output)return route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/javascript',body:output.text});
   if(path==='/workbench-api/v1/capabilities'&&method==='GET')return json({workbench:{agent_roles:false}});
   if(path==='/workbench-api/v1/projects'&&method==='GET')return json({items:projects.map(project=>({...project})),has_more:false});
   if(path==='/workbench-api/v1/projects'&&method==='POST'){
    createRequests++;const body=JSON.parse(request.postData()||'{}'),project={project_id:'p'+createRequests,title:body.title,version:1,is_default:false,archived:false,active_conversation_count:0,archived_conversation_count:0};projects.push(project);return json(project,201);
   }
   if(path==='/favicon.ico')return route.fulfill({status:204});
   faults.push(method+' '+path);return route.fulfill({status:404,body:'Not Found'});
  });
  const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>faults.push(error.message));await page.goto(origin);
  const browserContext=await page.evaluate(()=>({isSecureContext,cryptoRandomUUID:typeof crypto.randomUUID}));
  assert.equal(browserContext.isSecureContext,true);assert.equal(browserContext.cryptoRandomUUID,'function');
  const create=page.getByRole('button',{name:'创建项目',exact:true}),tap=async locator=>{const box=await locator.boundingBox();assert.ok(box);await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);};
  await tap(create);let input=page.getByLabel('新项目名称',{exact:true});await input.waitFor();
  assert.equal(await input.evaluate(node=>node===document.activeElement),true,'touch opening sends focus into the create form');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'320px project form has no horizontal overflow');
  await tap(page.getByRole('button',{name:'取消',exact:true}));assert.equal(await create.evaluate(node=>node===document.activeElement),true,'touch cancellation returns focus to the opener');

  await create.focus();await page.keyboard.press('Enter');input=page.getByLabel('新项目名称',{exact:true});await input.waitFor();
  await page.setViewportSize({width:760,height:320});
  assert.equal(await input.evaluate(node=>node===document.activeElement),true,'viewport rotation keeps focus in the open form');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'landscape project form has no horizontal overflow');
  await page.setViewportSize({width:320,height:760});
  assert.equal(await input.evaluate(node=>node===document.activeElement),true,'return to portrait keeps form focus');
  await input.fill('Rotated Project');await input.press('Enter');await page.getByText('Rotated Project',{exact:true}).waitFor();
  assert.equal(createRequests,1);assert.equal(await create.evaluate(node=>node===document.activeElement),true,'keyboard submit returns focus after save');
  assert.deepEqual(faults,[]);
 }finally{
  await browser?.close();const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});

test('ProjectsPanel rename form blocks Enter while composition state is active',{timeout:45000},async()=>{
 const base=process.env.TEMP??fileURLToPath(new URL('../../.test-tmp-project-focus/',import.meta.url));
 await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'ime-rename-case-')),projects=[{project_id:'p1',title:'Existing',version:1,is_default:false,archived:false,active_conversation_count:0,archived_conversation_count:0}],faults=[];
 let browser;
 try{
  const app=`import '../workbench-entry.css';import React from 'react';import{createRoot}from'react-dom/client';import ProjectsPanel from './ProjectsPanel';createRoot(document.getElementById('root')).render(<ProjectsPanel/>);`;
  const bundle=await build({stdin:{contents:app,resolveDir:fileURLToPath(new URL('./',import.meta.url)),loader:'tsx'},bundle:true,write:false,outfile:join(root,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({viewport:{width:320,height:760},isMobile:true,hasTouch:true});
  const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>faults.push(error.message));await page.setContent('<div id="root"></div>');
  await page.evaluate(initialProjects=>{
   window.__r5Requests=[];window.__r5SubmitCount=0;document.addEventListener('submit',()=>window.__r5SubmitCount++,true);
   window.fetch=async(url,init={})=>{const path=String(url).split('?')[0],method=String(init.method??'GET').toUpperCase();window.__r5Requests.push({path,method});
    let body,status=200;if(path==='/workbench-api/v1/projects'&&method==='GET')body={items:initialProjects,has_more:false};
    else if(path.startsWith('/workbench-api/v1/projects/')&&method==='PATCH'){const project=initialProjects.find(item=>path.endsWith('/'+item.project_id));body={...project,title:JSON.parse(init.body??'{}').title,version:project.version+1};}
    else{status=404;body={error:{code:'NOT_FOUND',message:'NOT_FOUND'}};}
    return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','x-csrf-token':'project-ime-test','x-workbench-draft-scope':'e'.repeat(64)}});
   };
  },projects);
  const script=bundle.outputFiles.find(file=>file.path.replaceAll('\\','/').endsWith('/bundle.js'));assert.ok(script,'browser test bundle was emitted');await page.addScriptTag({content:script.text});
  const rename=page.getByRole('button',{name:'重命名 Existing',exact:true});await rename.waitFor();await rename.focus();await page.keyboard.press('Enter');
  const input=page.getByLabel('项目名称',{exact:true});await input.waitFor();await input.fill('Research');
  await page.evaluate(()=>{window.__r5ImeEvents=[];document.addEventListener('keydown',event=>{if(event.key==='Enter')window.__r5ImeEvents.push({isComposing:event.isComposing,keyCode:event.keyCode});},true);});
  await input.evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
  await input.press('Enter');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.waitForTimeout(50);
  const enter=await page.evaluate(()=>window.__r5ImeEvents.at(-1));
  assert.equal(enter?.isComposing,false,'fixture uses an Enter key whose native composition flag is false');
  assert.equal(enter?.keyCode,13,'fixture uses ordinary Enter keycode while composition state is active');
  assert.equal(await page.evaluate(()=>window.__r5SubmitCount),0,'active composition must not submit the project rename form');
  assert.equal(await page.evaluate(()=>window.__r5Requests.filter(request=>request.method==='PATCH').length),0,'active composition must not send a project rename request');
  assert.equal(await input.inputValue(),'Research','composition confirmation preserves the rename draft');
  assert.deepEqual(faults,[]);
 }finally{
  await browser?.close();const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});