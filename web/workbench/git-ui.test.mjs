import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';import {chromium} from 'playwright';
import {buildServer as gatewayServer} from '../../packages/gateway/src/server.ts';import {buildServer as bffServer} from '../../src/server.mjs';

test('mobile Git workbench uses the actual owned BFF/API, rejects stale patches and ignores a late other-project response',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jot-git-ui-')),publicRoot=join(root,'public');await mkdir(publicRoot);
 let gateway,bff,browser,releaseOld;const blocked=new Promise(done=>releaseOld=done);let waitingOld;const oldReady=new Promise(done=>waitingOld=done);
 try{
  const bindings=[],indexes=[];
  for(const id of ['one','two']){const directory=join(root,id);await mkdir(directory);const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:directory,stdio:['ignore','pipe','pipe']});git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(directory,'note.txt'),'original\n');git('add','.');git('commit','-m','Synthetic fixture');indexes.push(await readFile(join(directory,'.git','index')));await writeFile(join(directory,'note.txt'),'after-'+id+'\n');await writeFile(join(directory,'another.txt'),'other-'+id+'\n');await writeFile(join(directory,'bytes.bin'),Buffer.from([0,1,2]));bindings.push({owner_id:'owner',project_id:'project-'+id,root:directory});}
  const origins=[],csrf='test-git-ui-upstream',templateRoot=fileURLToPath(new URL('../../packages/gateway/file-engine/templates/',import.meta.url));
  gateway=await gatewayServer({databasePath:join(root,'gateway.sqlite'),workspaces:['ws'],templateRoot,workbenchRoot:join(root,'workspaces'),uploadRoot:join(root,'files'),csrfToken:csrf,allowedOrigins:origins,gitRepositories:bindings});
  for(const id of ['one','two'])gateway.db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('project-'+id,'owner','Project '+id,0,1,new Date().toISOString(),new Date().toISOString());
  const gatewayUrl=await gateway.app.listen({host:'127.0.0.1',port:0});
  const source="import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Workbench from './Workbench';function App(){const[view,setView]=useState('agents');return <Workbench view={view} onOpen={setView} onConversation={()=>{}}/>}createRoot(document.getElementById('root')).render(<App/>);";
  await build({stdin:{contents:source,loader:'tsx',resolveDir:fileURLToPath(new URL('./',import.meta.url))},bundle:true,outfile:join(publicRoot,'bundle.js'),format:'iife',platform:'browser',logLevel:'silent'});
  await writeFile(join(publicRoot,'index.html'),'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script>');
  bff=await bffServer({demo:true,database:join(root,'bff.sqlite'),root:join(root,'local'),publicRoot,workbench:{url:gatewayUrl,owner:'owner',csrf}});const origin=await bff.app.listen({host:'127.0.0.1',port:0});origins.push(origin);
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(15000);const faults=[],methods=[];page.on('pageerror',error=>faults.push(error.message));page.on('request',request=>{if(request.url().includes('/workbench-api/'))methods.push(request.method());});
  await page.goto(origin);await page.getByRole('button',{name:'Git 工作台',exact:true}).click();
  const project=page.getByLabel('项目仓库',{exact:true});await project.selectOption('project-one');
  await page.getByRole('button',{name:'查看工作区差异：note.txt',exact:true}).click();await page.getByLabel('Git 差异',{exact:true}).getByText('+after-one',{exact:false}).waitFor();
  await page.route('**/workbench-api/v1/projects/project-one/git/diff?**',async route=>{const response=await route.fetch();waitingOld();await blocked;try{await route.fulfill({response});}catch{}});
  await page.getByRole('button',{name:'查看工作区差异：another.txt',exact:true}).click();await oldReady;
  await project.selectOption('project-two');await page.getByRole('button',{name:'查看工作区差异：note.txt',exact:true}).waitFor();releaseOld();
  await writeFile(join(root,'two','note.txt'),'latest-two\n');await page.getByRole('button',{name:'查看工作区差异：note.txt',exact:true}).click();await page.getByRole('alert').filter({hasText:'文件已变化，请刷新仓库'}).waitFor();
  assert.equal(await page.getByLabel('Git 差异',{exact:true}).count(),0);await page.getByRole('button',{name:'刷新仓库',exact:true}).click();await page.getByRole('button',{name:'查看工作区差异：note.txt',exact:true}).click();await page.getByLabel('Git 差异',{exact:true}).getByText('+latest-two',{exact:false}).waitFor();
  assert.equal((await page.locator('body').textContent()).includes('other-one'),false);await page.getByRole('button',{name:'查看工作区差异：bytes.bin',exact:true}).click();await page.getByText('二进制文件，暂无文本差异。',{exact:true}).waitFor();
  assert.deepEqual(faults,[]);assert.ok(methods.length>5&&methods.every(method=>method==='GET'));for(const [index,id] of ['one','two'].entries())assert.deepEqual(await readFile(join(root,id,'.git','index')),indexes[index]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 }finally{
  releaseOld?.();await browser?.close();if(bff){bff.app.server.closeAllConnections();await bff.close();}if(gateway){gateway.app.server.closeAllConnections();await gateway.app.close();gateway.db.close();}
  assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});
