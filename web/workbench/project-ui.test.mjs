import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {buildServer as gatewayServer} from '../../packages/gateway/src/server.ts';
import {buildServer as bffServer} from '../../src/server.mjs';

const workspace=resolve(fileURLToPath(new URL('../..',import.meta.url)));

test('Workbench creates, lists and renames projects, retrying a lost create response with the original request',async t=>{
 let gateway,bff,browser;const root=await mkdtemp(join(workspace,'.test-tmp-project-ui-'));
 t.after(async()=>{
  await browser?.close();
  if(bff){bff.app.server.closeAllConnections();await bff.close();}
  if(gateway){gateway.app.server.closeAllConnections();await gateway.app.close();gateway.db.close();}
  assert.ok(resolve(root).startsWith(workspace+sep));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 });
 const publicRoot=join(root,'public'),origins=[],csrf='test-project-ui-csrf-token';await mkdir(publicRoot);
 gateway=await gatewayServer({databasePath:join(root,'gateway.sqlite'),templateRoot:fileURLToPath(new URL('../../packages/gateway/file-engine/templates/',import.meta.url)),workspaces:['ws'],allowedOrigins:origins,csrfToken:csrf});
 const gatewayOrigin=await gateway.app.listen({host:'127.0.0.1',port:0});
 const source="import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Workbench from './Workbench';function App(){const[view,setView]=useState('projects');return <Workbench view={view} onOpen={setView} onConversation={()=>{}}/>}createRoot(document.getElementById('root')).render(<App/>);";
 await build({stdin:{contents:source,loader:'tsx',resolveDir:fileURLToPath(new URL('./',import.meta.url))},bundle:true,outfile:join(publicRoot,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
 await writeFile(join(publicRoot,'index.html'),'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>');
 bff=await bffServer({demo:true,database:join(root,'bff.sqlite'),root:join(root,'local'),publicRoot,workbench:{url:gatewayOrigin,owner:'owner',csrf}});
 const origin=await bff.app.listen({host:'127.0.0.1',port:0});origins.push(origin);
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{})});
 const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(12000);await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await page.goto(origin);
 const attempts=[];let loseCreateResponse=true;
 await page.route('**/workbench-api/v1/projects',async route=>{
  const request=route.request();if(request.method()==='POST'){
   attempts.push({key:request.headers()['idempotency-key'],body:request.postDataJSON()});
   if(loseCreateResponse){loseCreateResponse=false;await route.fetch();await route.abort('failed');return;}
  }
  await route.continue();
 });
 await page.getByRole('button',{name:'创建项目',exact:true}).click();
 await page.getByLabel('新项目名称', {exact:true}).fill('Research');
 await page.getByRole('button',{name:'保存项目',exact:true}).click();
 await page.getByRole('button',{name:'重试原请求',exact:true}).waitFor();
 await page.getByRole('button',{name:'重试原请求',exact:true}).click();
 await page.getByText('Research',{exact:true}).waitFor();
 assert.equal(attempts.length,2);assert.deepEqual(attempts[1],attempts[0]);
 assert.equal(gateway.db.prepare("SELECT count(*) AS count FROM ga_projects WHERE owner_id='owner' AND title='Research'").get().count,1);
 await page.getByRole('button',{name:'重命名 Research',exact:true}).click();
 await page.getByLabel('项目名称', {exact:true}).fill('Ideas');
 await page.getByRole('button',{name:'保存名称',exact:true}).click();
 await page.getByText('Ideas',{exact:true}).waitFor();
 assert.equal(gateway.db.prepare("SELECT count(*) AS count FROM ga_projects WHERE owner_id='owner' AND title='Ideas'").get().count,1);
 const secondTab=await browser.newPage({viewport:{width:390,height:844}});secondTab.setDefaultTimeout(12000);await secondTab.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await secondTab.goto(origin);
 await secondTab.getByRole('button',{name:'重命名 Ideas',exact:true}).click();await secondTab.getByLabel('项目名称',{exact:true}).fill('Remote Ideas');await secondTab.getByRole('button',{name:'保存名称',exact:true}).click();await secondTab.getByText('Remote Ideas',{exact:true}).waitFor();
 const renameAttempts=[];await page.route('**/workbench-api/v1/projects/*',async route=>{const request=route.request();if(request.method()==='PATCH')renameAttempts.push({key:request.headers()['idempotency-key'],body:request.postDataJSON()});await route.continue();});
 await page.getByRole('button',{name:'重命名 Ideas',exact:true}).click();await page.getByLabel('项目名称',{exact:true}).fill('Notes');await page.getByRole('button',{name:'保存名称',exact:true}).click();
 await page.getByRole('button',{name:'继续重命名 Remote Ideas',exact:true}).waitFor();assert.equal(await page.getByLabel('项目名称',{exact:true}).count(),0);assert.match(await page.getByRole('alert').textContent(),/保留.*Notes/);
 await page.getByRole('button',{name:'继续重命名 Remote Ideas',exact:true}).click();assert.equal(await page.getByLabel('项目名称',{exact:true}).inputValue(),'Notes');
 await page.getByRole('button',{name:'保存名称',exact:true}).click();await page.getByText('Notes',{exact:true}).waitFor();assert.equal(renameAttempts.length,2);assert.deepEqual(renameAttempts.map(attempt=>attempt.body),[{expected_version:2,title:'Notes'},{expected_version:3,title:'Notes'}]);assert.notEqual(renameAttempts[0].key,renameAttempts[1].key);
 assert.equal(gateway.db.prepare("SELECT count(*) AS count FROM ga_projects WHERE owner_id='owner' AND title='Notes'").get().count,1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
});
